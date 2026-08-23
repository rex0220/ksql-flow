import * as os from "os";
import { appIdMap, ResolvedProfile } from "../config";
import { ApiLimitError, ConfigError, errorMessage, LockedError, LockUnavailableError } from "../errors";
import { resolveGitRef, runJob, RUNNER_VERSION } from "../executor";
import { JobFile, loadJobDir, validateDependencyGraph } from "../jobs";
import { LocalLock } from "../lock";
import { toKintoneDateTime, truncateDetail } from "../logapp";
import { batchNotifyPayload, notifyFailure, notifyHeartbeat } from "../notify";
import { createRunnerEnv, effectiveTimeoutMs, parseAsOf, RunnerEnvBundle } from "../runner";
import { StateFile, StateStore } from "../state";
import { EXIT, ExitCode, JobOutcome, JobStatus } from "../types";
import { printOutcome } from "./run";
import { dryRunJob, DryRunReport } from "./dryrun";
import { printRunningTargets } from "./unlock";
import { version as engineVersion } from "@rex0220/kintone-sql-tools/flow";

export interface RunAllOptions {
  asOf?: string;
  dryRun?: boolean;
  strict?: boolean;
  sample?: number;
  json?: boolean;
  resume?: boolean;
  from?: string;
  only?: string;
  stopOnError?: boolean;
  continueOnError?: boolean;
  maxApiCalls?: number;
  lockLocalOnly?: boolean;
  forceUnlock?: boolean;
  baseFetch?: typeof fetch;
  out?: (line: string) => void;
  notifyFetch?: typeof fetch;
}

/** 依存を満たすステータス。裁定 Q2 に従い、これ以外はすべて停止伝播する。 */
const DEPENDENCY_SATISFIED_STATUSES: ReadonlySet<JobStatus> = new Set(["SUCCESS", "NO_DATA"]);

/** stop-on-error の起点となる失敗系ステータス */
const FAILURE_STATUSES: ReadonlySet<JobStatus> = new Set(["FAILED", "ABORTED", "TIMEOUT"]);

/** run-all（タスク指示書 D / F / K, 設計書 4・6・10.3） */
export async function runAllCommand(
  profile: ResolvedProfile,
  dir: string,
  options: RunAllOptions = {}
): Promise<ExitCode> {
  if (options.stopOnError === true && options.continueOnError === true) {
    console.error("エラー: --stop-on-error と --continue-on-error は同時に指定できません");
    return EXIT.VALIDATION;
  }
  const env = createRunnerEnv(profile, {
    maxApiCallsOverride: options.maxApiCalls,
    lockLocalOnly: options.lockLocalOnly,
    baseFetch: options.baseFetch,
    out: options.out,
    dryRun: options.dryRun,
    json: options.json,
  });
  const out = env.out;

  let jobs: JobFile[];
  try {
    jobs = loadJobDir(dir, appIdMap(profile));
    validateDependencyGraph(jobs);
  } catch (error) {
    out(`エラー: ${errorMessage(error)}`);
    return EXIT.VALIDATION;
  }

  // --- resume / from / only によるジョブ選抜 -------------------------------
  let asOf: Date;
  let selection: Set<string> | null = null; // null = 全ジョブ
  let recordFilteredJobs = false;
  let priorSuccess = new Set<string>();
  try {
    asOf = parseAsOf(options.asOf);
  } catch (error) {
    out(`エラー: ${errorMessage(error)}`);
    return EXIT.VALIDATION;
  }

  if (options.dryRun !== true && env.logApp === null) {
    if (!env.lockLocalOnly) {
      out("エラー: logApp が未設定のため分散ロックを確立できません。logApp を設定するか、--lock local-only を明示してください");
      return EXIT.VALIDATION;
    }
    out("  警告: logApp が未設定です。--lock local-only 指定によりローカルロックのみで続行します");
  }

  if (options.resume === true) {
    const resumed = await resolveResume(env, profile, jobs, options);
    if (resumed === null) {
      out("エラー: --resume に必要な直近バッチの実行記録が見つかりません（ログアプリ・profile 別 state とも）");
      return EXIT.VALIDATION;
    }
    selection = resumed.selection;
    priorSuccess = resumed.priorSuccess;
    if (options.asOf === undefined && resumed.asOf !== null) {
      asOf = resumed.asOf;
      out(`  --resume: 元セッションの as-of を引き継ぎます (${asOf.toISOString()})`);
    }
    if (selection.size === 0) {
      out("  --resume: 再実行が必要なジョブはありません");
      return EXIT.OK;
    }
  }

  if (options.only !== undefined) {
    const match = findJob(jobs, options.only);
    if (match === null) {
      out(`エラー: --only のジョブが見つかりません: ${options.only}`);
      return EXIT.VALIDATION;
    }
    selection = new Set([match.name]);
    recordFilteredJobs = true;
  } else if (options.from !== undefined) {
    const match = findJob(jobs, options.from);
    if (match === null) {
      out(`エラー: --from のジョブが見つかりません: ${options.from}`);
      return EXIT.VALIDATION;
    }
    const index = jobs.findIndex((job) => job.name === match.name);
    selection = new Set(jobs.slice(index).map((job) => job.name));
    recordFilteredJobs = true;
  }

  if (options.dryRun === true) {
    const warning = "ジョブ間のデータ依存は再現されません（前段ジョブの書き込みを行わないため、後段は現状データを参照します）";
    if (options.json !== true) out(`[DRY-RUN] 注意: ${warning}`);
    let worst: ExitCode = EXIT.OK;
    const reports: DryRunReport[] = [];
    for (const job of jobs) {
      if (selection !== null && !selection.has(job.name)) continue;
      const code = await dryRunJob(env, job, asOf, {
        sample: options.sample,
        json: options.json,
        strict: options.strict,
        emit: options.json !== true,
        onReport: (report) => reports.push(report),
      });
      worst = worseDryRunExit(worst, code);
    }
    if (options.json === true) {
      out(JSON.stringify({ formatVersion: 1, kind: "DRY_RUN_BATCH", warning, exitCode: worst, jobs: reports }));
    }
    return worst;
  }

  out(
    `[RUN-ALL] ${dir} (profile: ${profile.name}, as-of: ${asOf.toISOString()}, batch: ${env.batchId})`
  );

  // --- ローカルロック + バッチロック（設計書 5.5-3） ------------------------
  const localLock = new LocalLock(process.cwd(), profile.name);
  if (options.forceUnlock === true) {
    localLock.forceRelease();
    if (env.logApp !== null) {
      try {
        const running = await env.logApp.listRunning(profile.name);
        printRunningTargets(out, profile.name, running, "--force-unlock");
        for (const record of running) {
          await env.logApp.recoverStale(record, "--force-unlock による明示解除");
          out(`  RUNNING レコードを解除しました: ${record.jobKey}`);
        }
      } catch (error) {
        out(`  警告: ログアプリ側のロック解除に失敗しました: ${errorMessage(error)}`);
      }
    }
  }
  try {
    localLock.acquire(env.batchId, profile.limits.batchTimeoutSec);
  } catch (error) {
    out(`エラー: ${errorMessage(error)}`);
    return error instanceof LockedError ? EXIT.LOCKED : EXIT.RUNTIME;
  }

  const startedAt = new Date();
  const batchKey = `${profile.name}:__batch__`;
  let batchRecordId: string | null = null;
  try {
    if (env.logApp !== null) {
      try {
        await env.logApp.resendPending();
      } catch {
        /* 再送失敗は続行 */
      }
      const batchTimeoutSec = profile.limits.batchTimeoutSec;
      try {
        batchRecordId = await env.logApp.acquireLock({
          jobKey: batchKey,
          fields: {
            record_type: "BATCH",
            batch_id: env.batchId,
            script_name: dir,
            profile: profile.name,
            as_of: toKintoneDateTime(asOf),
            started_at: toKintoneDateTime(startedAt),
            executed_by: safeUser(),
            host: os.hostname(),
            git_ref: resolveGitRef(dir),
            ksql_version: `flow ${RUNNER_VERSION} / engine ${engineVersion}`,
          },
          staleBeforeMs: batchTimeoutSec !== null ? Date.now() - batchTimeoutSec * 1000 : null,
          onStaleRecovered: () => out(`  警告: stale バッチロックを自動回収しました (${batchKey})`),
        });
      } catch (error) {
        if (error instanceof LockedError) {
          out(`エラー: ${errorMessage(error)}`);
          return EXIT.LOCKED;
        }
        if (error instanceof LockUnavailableError && env.lockLocalOnly) {
          out("  警告: ログアプリに到達できません。--lock local-only 指定によりローカルロックのみで続行します");
        } else {
          throw error;
        }
      }
    }

    env.jsonl.append("batch_start", {
      batchId: env.batchId,
      dir,
      asOf: asOf.toISOString(),
      jobs: jobs.map((job) => job.name),
    });

    // --- 実行ループ --------------------------------------------------------
    const state = new StateStore(process.cwd(), profile.name, out);
    const stateFile: StateFile = {
      schemaVersion: 1,
      profile: profile.name,
      batchId: env.batchId,
      asOf: asOf.toISOString(),
      timezone: profile.timezone,
      startedAt: startedAt.toISOString(),
      jobs: {},
    };
    const outcomes: JobOutcome[] = [];
    const statusByName = new Map<string, JobStatus>();
    const batchDeadline =
      profile.limits.batchTimeoutSec !== null ? startedAt.getTime() + profile.limits.batchTimeoutSec * 1000 : null;
    let stopRequested = false;
    let batchTimedOut = false;

    for (const job of jobs) {
      if (selection !== null && !selection.has(job.name)) {
        // --from / --only の選抜外は監査用レコードだけを残す。結果・依存・通知には含めない。
        if (recordFilteredJobs) {
          out(`[SKIP] ${job.fileName} (filtered)`);
          await recordSkipped(env, job, asOf, "filtered", batchRecordId !== null);
          stateFile.jobs[job.name] = { fileName: job.fileName, status: "SKIPPED", skipReason: "filtered" };
          state.write(stateFile);
        }
        // resume で前回成功済み、または filtered のジョブは依存判定上は満たされたものとして扱う
        continue;
      }

      let skipReason: string | null = null;
      if (batchDeadline !== null && Date.now() >= batchDeadline) {
        batchTimedOut = true;
        skipReason = "batch-timeout";
      } else if (stopRequested) {
        skipReason = "stop-on-error";
      } else {
        const broken = job.dependsOn.find((dep) => {
          const status = statusByName.get(dep);
          if (status !== undefined) return !DEPENDENCY_SATISFIED_STATUSES.has(status);
          // 今回実行対象外の依存: resume では前回結果を参照
          if (selection !== null) return !priorSuccess.has(dep) && selection.has(dep);
          return false;
        });
        if (broken !== undefined) skipReason = `dependency: ${broken}`;
      }

      if (skipReason !== null) {
        const outcome = skippedOutcome(job, skipReason);
        outcomes.push(outcome);
        statusByName.set(job.name, "SKIPPED");
        out(`[SKIP] ${job.fileName} (${skipReason})`);
        await recordSkipped(env, job, asOf, skipReason, batchRecordId !== null);
        stateFile.jobs[job.name] = { fileName: job.fileName, status: "SKIPPED", skipReason };
        state.write(stateFile);
        continue;
      }

      out(`[JOB] ${job.fileName}`);
      let outcome: JobOutcome;
      try {
        outcome = await runJob(env, {
          job,
          asOf,
          batchId: env.batchId,
          parentBatchId: env.batchId,
          timeoutMs: effectiveTimeoutMs(job.timeoutSec, batchDeadline),
          jobKey: `${profile.name}:${job.name}`,
        });
      } catch (error) {
        if (error instanceof LockedError) {
          // 単発 run との衝突: 当該ジョブのみ SKIPPED (理由 LOCKED)、集約では 5（設計書 10.3）
          outcome = { ...skippedOutcome(job, "LOCKED"), exitCode: EXIT.LOCKED };
          out(`  ロック競合のためスキップします: ${errorMessage(error)}`);
        } else if (error instanceof ApiLimitError || error instanceof LockUnavailableError) {
          outcome = {
            ...skippedOutcome(job, ""),
            status: "FAILED",
            exitCode: EXIT.RUNTIME,
            errorMessage: errorMessage(error),
            skipReason: undefined,
          };
          out(`  エラー: ${errorMessage(error)}`);
          if (error instanceof ApiLimitError) stopRequested = true; // 上限超過は以降を安全停止
        } else {
          outcome = {
            ...skippedOutcome(job, ""),
            status: "FAILED",
            exitCode: EXIT.RUNTIME,
            errorMessage: errorMessage(error),
            skipReason: undefined,
          };
          out(`  エラー: ${errorMessage(error)}`);
        }
      }
      outcomes.push(outcome);
      statusByName.set(job.name, outcome.status);
      printOutcome(out, outcome);
      stateFile.jobs[job.name] = {
        fileName: job.fileName,
        status: outcome.status,
        startedAt: outcome.startedAt?.toISOString(),
        finishedAt: outcome.finishedAt?.toISOString(),
        error: outcome.errorMessage,
      };
      state.write(stateFile);

      if (FAILURE_STATUSES.has(outcome.status) && options.stopOnError === true) {
        stopRequested = true;
      }
    }

    // --- 集約（設計書 10.3） ------------------------------------------------
    const exitCode = aggregateExit(outcomes, options.continueOnError === true);
    const batchStatus = batchTimedOut ? "TIMEOUT" : aggregateStatus(outcomes);
    const finishedAt = new Date();
    stateFile.finishedAt = finishedAt.toISOString();
    state.write(stateFile);

    if (batchRecordId !== null && env.logApp !== null) {
      await env.logApp.finishRecord(batchRecordId, batchKey, batchStatus, {
        finished_at: toKintoneDateTime(finishedAt),
        duration_sec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
        read_count: outcomes.reduce((sum, outcome) => sum + outcome.readCount, 0),
        written_count: outcomes.reduce((sum, outcome) => sum + outcome.writtenCount, 0),
        deleted_count: outcomes.reduce((sum, outcome) => sum + outcome.deletedCount, 0),
        api_calls: env.http.snapshot(),
        error_message: env.masker.mask(
          outcomes
            .filter((outcome) => outcome.errorMessage !== undefined)
            .map((outcome) => `${outcome.scriptName}: ${outcome.errorMessage}`)
            .join("\n")
        ),
        log_detail: truncateDetail(
          outcomes.map((outcome) => `${outcome.scriptName}: ${outcome.status}`).join("\n")
        ),
      });
    }

    env.jsonl.append("batch_finish", {
      batchId: env.batchId,
      status: batchStatus,
      exitCode,
      jobs: Object.fromEntries(outcomes.map((outcome) => [outcome.jobName, outcome.status])),
    });

    out(`[RESULT] ${batchStatus} (exit ${exitCode}) — ${summaryLine(outcomes)}`);

    if (exitCode !== EXIT.OK) {
      await notifyFailure(
        profile,
        env.masker,
        batchNotifyPayload({
          batchId: env.batchId,
          profile: profile.name,
          asOf,
          status: batchStatus,
          exitCode,
          jobs: outcomes,
          startedAt,
          finishedAt,
          apiCalls: env.http.snapshot(),
        }),
        { fetchImpl: options.notifyFetch, out }
      );
    }
    await notifyHeartbeat(
      profile,
      env.masker,
      { batchId: env.batchId, status: batchStatus },
      { fetchImpl: options.notifyFetch, out }
    );
    return exitCode;
  } catch (error) {
    if (error instanceof LockUnavailableError) {
      out(`エラー: ${errorMessage(error)}（--lock local-only で明示的に緩和できます）`);
      return EXIT.RUNTIME;
    }
    out(`エラー: ${errorMessage(error)}`);
    return EXIT.RUNTIME;
  } finally {
    localLock.release();
  }
}

function worseDryRunExit(left: ExitCode, right: ExitCode): ExitCode {
  const priority: ExitCode[] = [EXIT.RUNTIME, EXIT.ABORTED, EXIT.VALIDATION, EXIT.OK];
  return priority.indexOf(left) <= priority.indexOf(right) ? left : right;
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

function findJob(jobs: JobFile[], key: string): JobFile | null {
  return jobs.find((job) => job.fileName === key || job.name === key) ?? null;
}

function skippedOutcome(job: JobFile, reason: string): JobOutcome {
  return {
    jobName: job.name,
    scriptName: job.fileName,
    status: "SKIPPED",
    exitCode: EXIT.OK,
    skipReason: reason,
    readCount: 0,
    writtenCount: 0,
    deletedCount: 0,
    apiCalls: 0,
    detailLines: [],
  };
}

async function recordSkipped(
  env: RunnerEnvBundle,
  job: JobFile,
  asOf: Date,
  reason: string,
  batchLockHeld: boolean
): Promise<void> {
  env.jsonl.append("job_skipped", { job: job.name, reason });
  if (env.logApp === null || !batchLockHeld) return;
  await env.logApp.insertRecord({
    record_type: "JOB",
    status: "SKIPPED",
    batch_id: env.batchId,
    parent_batch_id: env.batchId,
    script_name: job.fileName,
    profile: env.profile.name,
    as_of: toKintoneDateTime(asOf),
    started_at: toKintoneDateTime(new Date()),
    finished_at: toKintoneDateTime(new Date()),
    error_message: "",
    log_detail: `SKIPPED (${reason})`,
  });
}

/**
 * Exit Code 集約（設計書 10.3）:
 * 1. 全て SUCCESS / NO_DATA → 0
 * 2. --continue-on-error で成功と失敗が混在 → 4
 * 3. それ以外 → 失敗ジョブの最重大コード（3 > 2 > 5 > 1）
 */
export function aggregateExit(outcomes: JobOutcome[], continueOnError: boolean): ExitCode {
  const isSuccess = (outcome: JobOutcome) => outcome.status === "SUCCESS" || outcome.status === "NO_DATA";
  const failureCodes: ExitCode[] = [];
  for (const outcome of outcomes) {
    if (isSuccess(outcome)) continue;
    if (outcome.status === "SKIPPED") {
      // LOCKED 理由の SKIPPED は 5 として扱う。他の SKIPPED は集約対象外
      if (outcome.skipReason === "LOCKED") failureCodes.push(EXIT.LOCKED);
      continue;
    }
    failureCodes.push(outcome.exitCode);
  }
  if (failureCodes.length === 0) return EXIT.OK;
  const hasSuccess = outcomes.some(isSuccess);
  if (continueOnError && hasSuccess) return EXIT.PARTIAL;
  const priority: ExitCode[] = [EXIT.RUNTIME, EXIT.ABORTED, EXIT.LOCKED, EXIT.VALIDATION];
  for (const code of priority) {
    if (failureCodes.includes(code)) return code;
  }
  return failureCodes[0];
}

function aggregateStatus(outcomes: JobOutcome[]): JobStatus {
  const statuses = new Set(outcomes.map((outcome) => outcome.status));
  if (statuses.has("FAILED")) return "FAILED";
  if (statuses.has("TIMEOUT")) return "TIMEOUT";
  if (statuses.has("ABORTED")) return "ABORTED";
  if (statuses.has("SKIPPED")) {
    // 失敗なしで SKIPPED のみ（ロック競合等）
    return outcomes.every((outcome) => outcome.status === "SKIPPED") ? "SKIPPED" : "SUCCESS";
  }
  if (statuses.size === 1 && statuses.has("NO_DATA")) return "NO_DATA";
  return "SUCCESS";
}

function summaryLine(outcomes: JobOutcome[]): string {
  const count = (status: JobStatus) => outcomes.filter((outcome) => outcome.status === status).length;
  return (
    `SUCCESS ${count("SUCCESS")} / NO_DATA ${count("NO_DATA")} / FAILED ${count("FAILED")} / ` +
    `ABORTED ${count("ABORTED")} / TIMEOUT ${count("TIMEOUT")} / SKIPPED ${count("SKIPPED")}`
  );
}

/** --resume: ログアプリを正・state.json はフォールバック（設計書 6.2） */
async function resolveResume(
  env: RunnerEnvBundle,
  profile: ResolvedProfile,
  jobs: JobFile[],
  _options: RunAllOptions
): Promise<{ selection: Set<string>; priorSuccess: Set<string>; asOf: Date | null } | null> {
  const RERUN_STATUSES = new Set(["FAILED", "ABORTED", "SKIPPED", "TIMEOUT", "RUNNING"]);
  const byFileName = new Map(jobs.map((job) => [job.fileName, job.name]));

  if (env.logApp !== null) {
    try {
      const latest = await env.logApp.findLatestBatch(profile.name);
      if (latest !== null) {
        const records = await env.logApp.listBatchJobs(latest.batchId);
        const selection = new Set<string>();
        const priorSuccess = new Set<string>();
        const recorded = new Set<string>();
        for (const record of records) {
          const name = byFileName.get(record.scriptName);
          if (name === undefined) continue;
          recorded.add(name);
          const filtered = record.status === "SKIPPED" && record.logDetail.startsWith("SKIPPED (filtered)");
          if (filtered) continue;
          if (RERUN_STATUSES.has(record.status)) selection.add(name);
          else priorSuccess.add(name);
        }
        // JOB レコードが無いジョブは、クラッシュ前に未着手だったものとして再実行する。
        for (const job of jobs) {
          if (!recorded.has(job.name)) selection.add(job.name);
        }
        return {
          selection,
          priorSuccess,
          asOf: latest.asOf !== null ? new Date(latest.asOf) : null,
        };
      }
    } catch (error) {
      env.out(
        `  警告: ログアプリから resume 情報を取得できません。state.json へフォールバックします: ${errorMessage(error)}`
      );
    }
  }

  const state = new StateStore(process.cwd(), profile.name, env.out).read();
  if (state === null) return null;
  env.out("  警告: profile 別 state（ローカルフォールバック）を resume の正として使用します");
  const selection = new Set<string>();
  const priorSuccess = new Set<string>();
  for (const [name, jobState] of Object.entries(state.jobs)) {
    if (jobState.status === "SKIPPED" && jobState.skipReason === "filtered") continue;
    if (RERUN_STATUSES.has(jobState.status)) selection.add(name);
    else priorSuccess.add(name);
  }
  // state に載っていないジョブ（前回未着手）は再実行対象
  for (const job of jobs) {
    if (!(job.name in state.jobs)) selection.add(job.name);
  }
  const asOf = new Date(state.asOf);
  return { selection, priorSuccess, asOf: Number.isNaN(asOf.getTime()) ? null : asOf };
}
