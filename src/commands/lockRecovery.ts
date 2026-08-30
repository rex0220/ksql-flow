import type { ResolvedProfile } from "../config";
import { ConfigError } from "../errors";
import type { RunningRecord } from "../logapp";
import { createRunnerEnv } from "../runner";
import { EXIT, type ExitCode } from "../types";
import { writeJsonObject } from "./machineJson";

export type LockRecoveryOutcome =
  | "RELEASED"
  | "NOT_FOUND"
  | "NOT_RUNNING"
  | "CONFLICT"
  | "UNCONFIRMED";

interface CommandOptions {
  baseFetch?: typeof fetch;
  now?: () => Date;
  writeJson?: (value: Record<string, unknown>) => void;
}

/** 指定 job_key の RUNNING 状態を変更せず照会する。 */
export async function inspectLockCommand(
  profile: ResolvedProfile,
  jobKey: string,
  options: CommandOptions = {}
): Promise<ExitCode> {
  const writeJson = options.writeJson ?? writeJsonObject;
  const inspectedAt = (options.now ?? (() => new Date()))().toISOString();
  const env = createRunnerEnv(profile, { baseFetch: options.baseFetch, json: true, orchestrator: true });
  if (env.logApp === null) throw new ConfigError("inspect-lock には profile の logApp 設定が必要です");

  try {
    const record = await env.logApp.findByJobKey(jobKey);
    const running = record?.status === "RUNNING" ? record : null;
    writeJson({
      kind: "LOCK_INSPECTION_RESULT",
      formatVersion: 1,
      jobKey,
      locked: running !== null,
      record: running === null ? null : inspectionRecord(running),
      inspectedAt,
    });
    return EXIT.OK;
  } catch {
    writeJson({
      kind: "LOCK_INSPECTION_RESULT",
      formatVersion: 1,
      jobKey,
      locked: null,
      record: null,
      inspectedAt,
      error: { code: "LOCK_QUERY_UNAVAILABLE" },
    });
    return EXIT.RUNTIME;
  }
}

/** 停止確認証跡付きで、指定 job_key の RUNNING 1 件だけを楽観ロック解除する。 */
export async function forceUnlockJobCommand(
  profile: ResolvedProfile,
  input: { jobKey: string; reason: string; confirmedBy: string; evidenceRef: string },
  options: CommandOptions = {}
): Promise<ExitCode> {
  const writeJson = options.writeJson ?? writeJsonObject;
  const executedAtDate = (options.now ?? (() => new Date()))();
  const executedAt = executedAtDate.toISOString();
  const env = createRunnerEnv(profile, { baseFetch: options.baseFetch, json: true, orchestrator: true });
  if (env.logApp === null) throw new ConfigError("force-unlock-job には profile の logApp 設定が必要です");

  let observed: RunningRecord | null;
  try {
    observed = await env.logApp.findByJobKey(input.jobKey);
  } catch {
    return writeRecoveryResult(writeJson, input.jobKey, null, "UNCONFIRMED", executedAt);
  }
  if (observed === null) {
    return writeRecoveryResult(writeJson, input.jobKey, null, "NOT_FOUND", executedAt);
  }
  if (observed.status !== "RUNNING") {
    return writeRecoveryResult(writeJson, input.jobKey, observed, "NOT_RUNNING", executedAt);
  }

  let outcome: LockRecoveryOutcome;
  try {
    outcome = await env.logApp.forceUnlockJob({
      observed,
      reason: input.reason,
      confirmedBy: input.confirmedBy,
      evidenceRef: input.evidenceRef,
      profileName: profile.name,
      executedAt: executedAtDate,
    });
  } catch {
    outcome = "UNCONFIRMED";
  }
  return writeRecoveryResult(writeJson, input.jobKey, observed, outcome, executedAt);
}

function inspectionRecord(record: RunningRecord) {
  return {
    recordId: record.id,
    batchId: record.batchId,
    startedAt: record.startedAt,
    host: record.host,
    scriptName: record.scriptName,
  };
}

function writeRecoveryResult(
  writeJson: (value: Record<string, unknown>) => void,
  jobKey: string,
  beforeRecord: RunningRecord | null,
  outcome: LockRecoveryOutcome,
  executedAt: string
): ExitCode {
  writeJson({
    kind: "LOCK_RECOVERY_RESULT",
    formatVersion: 1,
    jobKey,
    recordId: beforeRecord?.id ?? null,
    outcome,
    before: beforeRecord === null ? null : {
      batchId: beforeRecord.batchId,
      startedAt: beforeRecord.startedAt,
      host: beforeRecord.host,
    },
    executedAt,
    ...(outcome === "UNCONFIRMED"
      ? { nextAction: `ksql-flow inspect-lock --job-key ${jobKey} --profile <p> --config <path> --json で再照会してください` }
      : {}),
  });
  if (outcome === "CONFLICT") return EXIT.LOCKED;
  if (outcome === "UNCONFIRMED") return EXIT.RUNTIME;
  return EXIT.OK;
}
