import * as crypto from "crypto";
import * as fs from "fs";
import { version as engineVersion } from "@rex0220/kintone-sql-tools/flow";
import { appIdMap, ResolvedProfile } from "../config";
import {
  ApiLimitError,
  classifyRuntimeError,
  ConfigError,
  errorMessage,
  LockedError,
  LockUnavailableError,
} from "../errors";
import { normalizeJobOutcome, RuntimeFailureKind, writeExecutionResult } from "../contract";
import { runJob, RUNNER_VERSION } from "../executor";
import { loadJobFile } from "../jobs";
import { buildJobKey } from "../jobkey";
import { ORCHESTRATOR_LOG_APP_FIELD_CODES } from "../logapp";
import { LocalLock } from "../lock";
import { SecretMasker } from "../logging/mask";
import { notifyFailure, notifyHeartbeat } from "../notify";
import { createRunnerEnv, effectiveTimeoutMs, parseAsOf, RunnerEnvBundle } from "../runner";
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
  resultJson?: string;
  correlationId?: string;
  attemptId?: string;
  expectedJobId?: string;
}

export interface OrchestratorRunOptions extends RunOptions {
  resultJson: string;
  correlationId: string;
  attemptId: string;
  expectedJobId: string;
}

/** 単一ジョブ実行（タスク指示書 C / M2） */
export async function runCommand(
  profile: ResolvedProfile,
  filePath: string,
  options: RunOptions = {}
): Promise<ExitCode> {
  if (hasAnyOrchestratorOption(options)) {
    if (!hasCompleteOrchestratorOptions(options)) {
      (options.out ?? console.error)("エラー: orchestrator モードの 4 フラグは全て指定してください");
      return EXIT.VALIDATION;
    }
    return runOrchestratedCommand(profile, filePath, options);
  }
  return runStandaloneCommand(profile, filePath, options);
}

async function runStandaloneCommand(
  profile: ResolvedProfile,
  filePath: string,
  options: RunOptions
): Promise<ExitCode> {
  let env: RunnerEnvBundle;
  try {
    env = createRunnerEnv(profile, {
      maxApiCallsOverride: options.maxApiCalls,
      lockLocalOnly: options.lockLocalOnly,
      baseFetch: options.baseFetch,
      out: options.out,
      dryRun: options.dryRun,
      json: options.json,
    });
  } catch (error) {
    (options.out ?? console.error)(`エラー: ${errorMessage(error)}`);
    return (error as { exitCode?: ExitCode }).exitCode ?? EXIT.RUNTIME;
  }
  const out = env.out;

  let job;
  let jobKey: string;
  let asOf: Date;
  try {
    job = loadJobFile(filePath, appIdMap(profile));
    jobKey = buildJobKey(profile.name, job.name);
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
      jobKey,
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

const ORCHESTRATOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function hasAnyOrchestratorOption(options: RunOptions): boolean {
  return (
    options.resultJson !== undefined ||
    options.correlationId !== undefined ||
    options.attemptId !== undefined ||
    options.expectedJobId !== undefined
  );
}

function hasCompleteOrchestratorOptions(options: RunOptions): options is OrchestratorRunOptions {
  return (
    typeof options.resultJson === "string" &&
    typeof options.correlationId === "string" &&
    typeof options.attemptId === "string" &&
    typeof options.expectedJobId === "string"
  );
}

function validateOrchestratorOptions(profile: ResolvedProfile, options: OrchestratorRunOptions): void {
  if (options.resultJson.length === 0) throw new ConfigError("--result-json は空にできません");
  for (const [flag, value] of [
    ["--correlation-id", options.correlationId],
    ["--attempt-id", options.attemptId],
    ["--expected-job-id", options.expectedJobId],
  ] as const) {
    if (!ORCHESTRATOR_ID_PATTERN.test(value)) {
      throw new ConfigError(`${flag} は ^[A-Za-z0-9._:-]{1,128}$ に一致する値を指定してください`);
    }
  }
  if (options.dryRun === true || options.json === true || options.sample !== undefined) {
    throw new ConfigError("orchestrator モードは --dry-run / --json / --sample と併用できません");
  }
  if (options.lockLocalOnly === true) {
    throw new ConfigError("orchestrator モードは --lock local-only と併用できません");
  }
  if (profile.logApp === undefined) {
    throw new ConfigError("orchestrator モードには logApp の設定が必要です");
  }
  if (options.resultJson !== "-" && fs.existsSync(options.resultJson)) {
    throw new ConfigError(`Execution Result の出力先は既に存在します: ${options.resultJson}`);
  }
}

/**
 * Execution Contract v1 の単一 run。standalone 経路へ出力規律や終了処理を波及させないため分離する。
 */
async function runOrchestratedCommand(
  profile: ResolvedProfile,
  filePath: string,
  options: OrchestratorRunOptions
): Promise<ExitCode> {
  const executionId = crypto.randomUUID();
  const fallbackMasker = new SecretMasker(profile);
  let out = options.out ?? ((line: string) => console.error(fallbackMasker.mask(line)));
  let env: RunnerEnvBundle | null = null;
  let localLock: LocalLock | null = null;
  let lockAcquired = false;
  let outcome: JobOutcome | null = null;
  let cause: unknown;
  let failureKind: RuntimeFailureKind | undefined;
  let diagnosticCode: string | undefined;
  let observedExecutionErrorCode: string | undefined;
  let asOf: Date | null = null;
  let asOfEcho: string = options.asOf ?? new Date().toISOString();
  let executionStarted = false;
  let executionStartedAt: Date | null = null;
  let ranJob = false;

  try {
    validateOrchestratorOptions(profile, options);
    env = createRunnerEnv(profile, {
      batchId: executionId,
      maxApiCallsOverride: options.maxApiCalls,
      baseFetch: options.baseFetch,
      out: options.out,
      orchestrator: true,
      correlation: {
        correlationId: options.correlationId,
        attemptId: options.attemptId,
        executionId,
      },
    });
    out = env.out;

    const job = loadJobFile(filePath, appIdMap(profile));
    if (job.name !== options.expectedJobId) {
      throw new ConfigError(
        `--expected-job-id がジョブ論理名と一致しません: expected=${options.expectedJobId}, actual=${job.name}`
      );
    }
    const jobKey = buildJobKey(profile.name, job.name);
    asOf = parseAsOf(options.asOf);
    asOfEcho = options.asOf ?? asOf.toISOString();

    await env.logApp!.requireFields(ORCHESTRATOR_LOG_APP_FIELD_CODES);

    out(`[RUN] ${job.fileName} (profile: ${profile.name}, as-of: ${asOf.toISOString()})`);
    localLock = new LocalLock(process.cwd(), profile.name);
    localLock.acquire(env.batchId, profile.limits.batchTimeoutSec);
    lockAcquired = true;

    try {
      await env.logApp!.resendPending();
    } catch (error) {
      out(`  警告: 未送信ログの再送に失敗しました: ${errorMessage(error)}`);
    }

    const batchDeadline =
      profile.limits.batchTimeoutSec !== null ? Date.now() + profile.limits.batchTimeoutSec * 1000 : null;
    ranJob = true;
    outcome = await runJob(env, {
      job,
      asOf,
      batchId: env.batchId,
      timeoutMs: effectiveTimeoutMs(job.timeoutSec, batchDeadline),
      jobKey,
      correlation: { correlationId: options.correlationId, attemptId: options.attemptId },
      durableExecutionStarted: true,
      onExecutionStart: (startedAt) => {
        executionStarted = true;
        executionStartedAt = startedAt;
      },
      onExecutionError: (error, code) => {
        cause = error;
        if (code !== undefined) observedExecutionErrorCode = code;
      },
    });

    if (!executionStarted && outcome.exitCode === EXIT.VALIDATION) {
      diagnosticCode = job.parsed.diagnostics.find((item) => item.severity === "error")?.code;
    } else if (executionStarted && outcome.exitCode === EXIT.VALIDATION) {
      diagnosticCode = observedExecutionErrorCode;
    }
    if (executionStarted && outcome.status === "FAILED" && outcome.exitCode === EXIT.RUNTIME && cause === undefined) {
      // runJob が Exit 3 に分類した実行中失敗は HTTP／ネットワーク／API 上限系。
      failureKind = "API_ERROR";
    }

    printOutcome(out, outcome);
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
  } catch (error) {
    cause = error;
    const exitCode = orchestratorExitCode(error, ranJob);
    if (error instanceof LockedError) {
      outcome = syntheticOutcome(options.expectedJobId, filePath, "LOCKED", EXIT.LOCKED, errorMessage(error));
    } else {
      outcome = syntheticOutcome(options.expectedJobId, filePath, "FAILED", exitCode, errorMessage(error));
      if (error instanceof LockUnavailableError) failureKind = "LOCK_UNAVAILABLE";
      else if (exitCode === EXIT.RUNTIME) failureKind = "INTERNAL_ERROR";
    }
    out(`エラー: ${errorMessage(error)}`);
  } finally {
    if (lockAcquired) localLock?.release();
  }

  const finalOutcome = outcome ?? syntheticOutcome(
    options.expectedJobId,
    filePath,
    "FAILED",
    EXIT.RUNTIME,
    "Execution Result を構築できませんでした"
  );
  const finishedAt = new Date();
  const result = normalizeJobOutcome(finalOutcome, {
    correlationId: options.correlationId,
    attemptId: options.attemptId,
    executionId,
    profile: profile.name,
    asOf: asOfEcho,
    executionStarted,
    startedAt: executionStartedAt,
    finishedAt,
    lastSuccessfulChunkNo:
      finalOutcome.writeChunks !== undefined && finalOutcome.writeChunks > 0 ? finalOutcome.writeChunks : null,
    ksqlFlowVersion: RUNNER_VERSION,
    engineVersion,
    failureKind,
    cause,
    error: {
      ...(diagnosticCode !== undefined ? { code: diagnosticCode } : {}),
      ...(finalOutcome.errorMessage !== undefined ? { message: finalOutcome.errorMessage } : {}),
    },
    masker: env?.masker ?? fallbackMasker,
  });

  try {
    writeExecutionResult(options.resultJson, result);
  } catch (error) {
    out(`エラー: Execution Result を出力できません: ${errorMessage(error)}`);
  }
  return result.exitCode;
}

function orchestratorExitCode(error: unknown, ranJob: boolean): ExitCode {
  if (error instanceof LockedError) return EXIT.LOCKED;
  if (error instanceof ConfigError) return EXIT.VALIDATION;
  if (error instanceof LockUnavailableError || error instanceof ApiLimitError) return EXIT.RUNTIME;
  if (ranJob) return classifyRuntimeError(error);
  return EXIT.RUNTIME;
}

function syntheticOutcome(
  jobName: string,
  filePath: string,
  status: JobOutcome["status"],
  exitCode: ExitCode,
  message: string
): JobOutcome {
  return {
    jobName,
    scriptName: filePath,
    status,
    exitCode,
    errorMessage: message,
    finishedAt: new Date(),
    readCount: 0,
    writtenCount: 0,
    deletedCount: 0,
    apiCalls: 0,
    detailLines: [],
  };
}

/** config 読込など runCommand 到達前の controlled failure を schema-valid な結果へ変換する。 */
export function writeOrchestratorStartupFailure(
  options: Pick<OrchestratorRunOptions, "resultJson" | "correlationId" | "attemptId" | "expectedJobId" | "asOf">,
  profileName: string,
  error: unknown,
  exitCode: ExitCode = EXIT.VALIDATION,
  masker: Pick<SecretMasker, "mask"> = { mask: (value) => value }
): ExitCode {
  const executionId = crypto.randomUUID();
  const finishedAt = new Date();
  const outcome = syntheticOutcome(options.expectedJobId, "", "FAILED", exitCode, errorMessage(error));
  const result = normalizeJobOutcome(outcome, {
    correlationId: options.correlationId,
    attemptId: options.attemptId,
    executionId,
    profile: profileName,
    asOf: options.asOf ?? finishedAt.toISOString(),
    executionStarted: false,
    startedAt: null,
    finishedAt,
    lastSuccessfulChunkNo: null,
    ksqlFlowVersion: RUNNER_VERSION,
    engineVersion,
    ...(exitCode === EXIT.RUNTIME ? { failureKind: "INTERNAL_ERROR" as const } : {}),
    cause: error,
    error: { message: errorMessage(error) },
    masker,
  });
  console.error(masker.mask(`エラー: ${errorMessage(error)}`));
  try {
    writeExecutionResult(options.resultJson, result);
  } catch (writeError) {
    console.error(masker.mask(`エラー: Execution Result を出力できません: ${errorMessage(writeError)}`));
  }
  return result.exitCode;
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
