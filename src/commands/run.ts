import { appIdMap, ResolvedProfile } from "../config";
import { ApiLimitError, errorMessage, LockedError, LockUnavailableError } from "../errors";
import { runJob } from "../executor";
import { loadJobFile } from "../jobs";
import { LocalLock } from "../lock";
import { notifyFailure, notifyHeartbeat } from "../notify";
import { createRunnerEnv, effectiveTimeoutMs, parseAsOf } from "../runner";
import { EXIT, ExitCode, JobOutcome } from "../types";
import { dryRunJob } from "./dryrun";
import { printRunningTargets } from "./unlock";

export interface RunOptions {
  asOf?: string;
  dryRun?: boolean;
  strict?: boolean;
  sample?: number;
  json?: boolean;
  maxApiCalls?: number;
  lockLocalOnly?: boolean;
  forceUnlock?: boolean;
  baseFetch?: typeof fetch;
  out?: (line: string) => void;
  /** 通知の fetch 差し替え（テスト用） */
  notifyFetch?: typeof fetch;
}

/** 単一ジョブ実行（タスク指示書 C / M2） */
export async function runCommand(
  profile: ResolvedProfile,
  filePath: string,
  options: RunOptions = {}
): Promise<ExitCode> {
  const env = createRunnerEnv(profile, {
    maxApiCallsOverride: options.maxApiCalls,
    lockLocalOnly: options.lockLocalOnly,
    baseFetch: options.baseFetch,
    out: options.out,
    dryRun: options.dryRun,
    json: options.json,
  });
  const out = env.out;

  let job;
  let asOf: Date;
  try {
    job = loadJobFile(filePath, appIdMap(profile));
    asOf = parseAsOf(options.asOf);
  } catch (error) {
    out(`エラー: ${errorMessage(error)}`);
    return EXIT.VALIDATION;
  }

  if (options.dryRun === true) {
    return dryRunJob(env, job, asOf, { sample: options.sample, json: options.json, strict: options.strict });
  }

  if (env.logApp === null) {
    if (!env.lockLocalOnly) {
      out("エラー: logApp が未設定のため分散ロックを確立できません。logApp を設定するか、--lock local-only を明示してください");
      return EXIT.VALIDATION;
    }
    out("  警告: logApp が未設定です。--lock local-only 指定によりローカルロックのみで続行します");
  }

  out(`[RUN] ${job.fileName} (profile: ${profile.name}, as-of: ${asOf.toISOString()})`);

  const localLock = new LocalLock(process.cwd(), profile.name);
  if (options.forceUnlock === true) {
    const removed = localLock.forceRelease();
    if (removed) out("  前回のローカルロックを解除しました (--force-unlock)");
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

  let outcome: JobOutcome;
  try {
    // 未送信ログの再送（設計書 8.3。ロック確保後に行う）
    if (env.logApp !== null && !env.lockLocalOnly) {
      try {
        await env.logApp.resendPending();
      } catch (error) {
        out(`  警告: 未送信ログの再送に失敗しました: ${errorMessage(error)}`);
      }
    }

    const batchDeadline =
      profile.limits.batchTimeoutSec !== null ? Date.now() + profile.limits.batchTimeoutSec * 1000 : null;
    outcome = await runJob(env, {
      job,
      asOf,
      batchId: env.batchId,
      timeoutMs: effectiveTimeoutMs(job.timeoutSec, batchDeadline),
      jobKey: `${profile.name}:${job.name}`,
    });
  } catch (error) {
    if (error instanceof LockedError) {
      out(`エラー: ${errorMessage(error)}`);
      return EXIT.LOCKED;
    }
    if (error instanceof LockUnavailableError) {
      out(`エラー: ${errorMessage(error)}（--lock local-only で明示的に緩和できます）`);
      return EXIT.RUNTIME;
    }
    if (error instanceof ApiLimitError) {
      out(`エラー: ${errorMessage(error)}`);
      return EXIT.RUNTIME;
    }
    out(`エラー: ${errorMessage(error)}`);
    return EXIT.RUNTIME;
  } finally {
    localLock.release();
  }

  printOutcome(out, outcome);

  // 通知（仕様書 7.3）。失敗時は onFailure、heartbeat: always なら両方を送る。
  if (outcome.status === "FAILED" || outcome.status === "ABORTED" || outcome.status === "TIMEOUT") {
    await notifyFailure(
      profile,
      env.masker,
      {
        kind: "job",
        batchId: env.batchId,
        status: outcome.status,
        exitCode: outcome.exitCode,
        asOf: asOf.toISOString(),
        jobs: [outcome],
      },
      { fetchImpl: options.notifyFetch, out }
    );
  }
  await notifyHeartbeat(
    profile,
    env.masker,
    { batchId: env.batchId, status: outcome.status },
    { fetchImpl: options.notifyFetch, out }
  );

  return outcome.exitCode;
}

export function printOutcome(out: (line: string) => void, outcome: JobOutcome): void {
  out(
    `  => ${outcome.status} (exit ${outcome.exitCode}) 読取 ${outcome.readCount} 件 / ` +
      `書込 ${outcome.writtenCount} 件 / API ${outcome.apiCalls} 回`
  );
  if (outcome.errorMessage !== undefined) {
    out(`  エラー内容: ${outcome.errorMessage}`);
  }
  if (outcome.status === "FAILED") {
    out("  ヒント: 冪等設計（UPSERT/MERGE）のジョブは同じ as-of での単独リラン（run-all --resume / --only）で復旧できます");
  }
}
