import {
  ApiLimitError,
  findHttpStatus,
  HttpRetryExhaustedError,
  isNetworkError,
  LockUnavailableError,
} from "../errors";
import { stripSqlLiterals, type SecretMasker } from "../logging/mask";
import { EXIT, type JobOutcome } from "../types";

export const EXECUTION_CONTRACT = "ksql-flow.execution/v1" as const;
export const EXECUTION_RESULT_FORMAT_VERSION = 1 as const;
export const EXECUTION_RESULT_KIND = "EXECUTION_RESULT" as const;
export const EXECUTION_ERROR_MESSAGE_MAX_LENGTH = 2_000;

export const KNOWN_RESULT_CODES = [
  "OK",
  "NO_DATA",
  "VALIDATION_ERROR",
  "SQL_ERROR",
  "ASSERT_FAILED",
  "EXECUTION_TIMEOUT",
  "AUTH_ERROR",
  "API_ERROR",
  "LOCK_UNAVAILABLE",
  "INTERNAL_ERROR",
  "CANCELLED",
  "LOCK_CONFLICT",
] as const;

export type KnownResultCode = (typeof KNOWN_RESULT_CODES)[number];

/**
 * v1 の resultCode は additive であるため、受信側の型は既知コードだけに閉じない。
 * 本ランナーが生成するコードは KnownResultCode に限定する。
 */
export type ExecutionResultCode = string;

export type ExecutionResultStatus = "SUCCESS" | "FAILED" | "CANCELLED";

/** v1 初版でランナーが生成する error.category。将来の追加は contract v1 内で additive。 */
export type ExecutionErrorCategory =
  | "CONFIG"
  | "SQL"
  | "ASSERT"
  | "API"
  | "AUTH"
  | "TIMEOUT"
  | "LOCK"
  | "INTERNAL"
  | "CANCELLED";

export interface ExecutionResultError {
  category: ExecutionErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  detailsTruncated: boolean;
}

export interface ExecutionResult {
  formatVersion: typeof EXECUTION_RESULT_FORMAT_VERSION;
  kind: typeof EXECUTION_RESULT_KIND;
  contract: typeof EXECUTION_CONTRACT;
  correlationId: string;
  attemptId: string;
  executionId: string;
  jobId: string;
  profile: string;
  status: ExecutionResultStatus;
  resultCode: ExecutionResultCode;
  executionStarted: boolean;
  exitCode: 0 | 1 | 2 | 3 | 5;
  asOf: string | null;
  startedAt: string | null;
  finishedAt: string;
  durationMs: number;
  readCount: number;
  writtenCount: number;
  deletedCount: number;
  apiCalls: number;
  lastSuccessfulChunkNo: number | null;
  lastWrittenKey: string | null;
  ksqlFlowVersion: string;
  engineVersion: string;
  error: ExecutionResultError | null;
}

/** JobOutcome の FAILED / Exit 3 だけでは区別できない契約上の原因。 */
export type RuntimeFailureKind =
  | "AUTH_ERROR"
  | "API_ERROR"
  | "LOCK_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "CANCELLED";

export interface ExecutionErrorInput {
  /** エンジン／HTTP 層が公開する安定 code。省略時は resultCode ごとの既定値。 */
  code?: string;
  /** Error.message 相当だけを渡す。stack、HTTP response body は渡さない。 */
  message?: string;
  retryable?: boolean;
  /** 上流ですでに詳細を除去・切詰めた場合に true。 */
  detailsTruncated?: boolean;
}

export interface NormalizeExecutionResultContext {
  correlationId: string;
  attemptId: string;
  executionId: string;
  profile: string;
  /** 検証済みの入力文字列をそのまま渡す。省略時実行は解決済み ISO 文字列。 */
  asOf: string | null;
  executionStarted: boolean;
  /** 最初の SQL 文開始直前。executionStarted=false なら無視して null にする。 */
  startedAt?: Date | null;
  finishedAt?: Date;
  lastSuccessfulChunkNo?: number | null;
  ksqlFlowVersion: string;
  engineVersion: string;
  failureKind?: RuntimeFailureKind;
  /** Exit 3 の AUTH / API / LOCK / INTERNAL 判定に使う元例外。 */
  cause?: unknown;
  error?: ExecutionErrorInput;
  /** controlled failure でも必ず明示し、error.message と診断キーに適用する。 */
  masker: Pick<SecretMasker, "mask">;
}

interface ResolvedDisposition {
  status: ExecutionResultStatus;
  resultCode: KnownResultCode;
  exitCode: ExecutionResult["exitCode"];
}

const ERROR_DEFAULTS: Record<
  Exclude<KnownResultCode, "OK" | "NO_DATA">,
  { category: ExecutionErrorCategory; code: string; message: string }
> = {
  VALIDATION_ERROR: { category: "CONFIG", code: "VALIDATION_ERROR", message: "validation failed" },
  SQL_ERROR: { category: "SQL", code: "SQL_ERROR", message: "SQL execution failed" },
  ASSERT_FAILED: { category: "ASSERT", code: "ASSERT_VIOLATION", message: "ASSERT condition failed" },
  EXECUTION_TIMEOUT: { category: "TIMEOUT", code: "EXECUTION_TIMEOUT", message: "execution timed out" },
  AUTH_ERROR: { category: "AUTH", code: "AUTH_ERROR", message: "authentication or authorization failed" },
  API_ERROR: { category: "API", code: "API_ERROR", message: "API request failed" },
  LOCK_UNAVAILABLE: { category: "LOCK", code: "LOCK_UNAVAILABLE", message: "job lock could not be established" },
  INTERNAL_ERROR: { category: "INTERNAL", code: "INTERNAL_ERROR", message: "internal runner error" },
  CANCELLED: { category: "CANCELLED", code: "CANCELLED", message: "execution was cancelled" },
  LOCK_CONFLICT: { category: "LOCK", code: "LOCK_CONFLICT", message: "job lock is already held" },
};

/**
 * 既存 JobOutcome を Execution Contract v1 の出力境界へ正規化する。
 * 既存 status、Exit、CLI 出力には手を加えず、矛盾した組合せは出力せず例外にする。
 */
export function normalizeJobOutcome(
  outcome: JobOutcome,
  context: NormalizeExecutionResultContext
): ExecutionResult {
  const disposition = resolveDisposition(outcome, context);
  const finishedAt = context.finishedAt ?? outcome.finishedAt ?? new Date();
  const startedAt = resolveStartedAt(outcome, context);
  const executionStarted = context.executionStarted;

  return {
    formatVersion: EXECUTION_RESULT_FORMAT_VERSION,
    kind: EXECUTION_RESULT_KIND,
    contract: EXECUTION_CONTRACT,
    correlationId: requireNonEmpty(context.correlationId, "correlationId"),
    attemptId: requireNonEmpty(context.attemptId, "attemptId"),
    executionId: requireNonEmpty(context.executionId, "executionId"),
    jobId: requireNonEmpty(outcome.jobName, "jobId"),
    profile: requireNonEmpty(context.profile, "profile"),
    status: disposition.status,
    resultCode: disposition.resultCode,
    executionStarted,
    exitCode: disposition.exitCode,
    asOf: context.asOf,
    startedAt: startedAt?.toISOString() ?? null,
    finishedAt: finishedAt.toISOString(),
    durationMs: startedAt === null ? 0 : Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    readCount: executionStarted ? nonNegativeInteger(outcome.readCount) : 0,
    writtenCount: executionStarted ? nonNegativeInteger(outcome.writtenCount) : 0,
    deletedCount: executionStarted ? nonNegativeInteger(outcome.deletedCount) : 0,
    apiCalls: executionStarted ? nonNegativeInteger(outcome.apiCalls) : 0,
    lastSuccessfulChunkNo:
      executionStarted && context.lastSuccessfulChunkNo != null
        ? nonNegativeInteger(context.lastSuccessfulChunkNo)
        : null,
    lastWrittenKey:
      executionStarted && outcome.lastWrittenKey !== undefined
        ? context.masker.mask(outcome.lastWrittenKey)
        : null,
    ksqlFlowVersion: requireNonEmpty(context.ksqlFlowVersion, "ksqlFlowVersion"),
    engineVersion: requireNonEmpty(context.engineVersion, "engineVersion"),
    error: isFailureResultCode(disposition.resultCode)
      ? buildExecutionError(disposition.resultCode, outcome, context)
      : null,
  };
}

function resolveDisposition(outcome: JobOutcome, context: NormalizeExecutionResultContext): ResolvedDisposition {
  if (context.failureKind === "CANCELLED") {
    requireOutcome(outcome, "FAILED", EXIT.RUNTIME, "CANCELLED");
    return { status: "CANCELLED", resultCode: "CANCELLED", exitCode: EXIT.RUNTIME };
  }

  switch (outcome.status) {
    case "SUCCESS":
      requireExit(outcome, EXIT.OK);
      requireExecutionStarted(context, "OK");
      return { status: "SUCCESS", resultCode: "OK", exitCode: EXIT.OK };
    case "NO_DATA":
      requireExit(outcome, EXIT.OK);
      requireExecutionStarted(context, "NO_DATA");
      return { status: "SUCCESS", resultCode: "NO_DATA", exitCode: EXIT.OK };
    case "ABORTED":
      requireExit(outcome, EXIT.ABORTED);
      requireExecutionStarted(context, "ASSERT_FAILED");
      return { status: "FAILED", resultCode: "ASSERT_FAILED", exitCode: EXIT.ABORTED };
    case "TIMEOUT":
      requireExit(outcome, EXIT.RUNTIME);
      requireExecutionStarted(context, "EXECUTION_TIMEOUT");
      return { status: "FAILED", resultCode: "EXECUTION_TIMEOUT", exitCode: EXIT.RUNTIME };
    case "LOCKED":
      requireExit(outcome, EXIT.LOCKED);
      requireExecutionNotStarted(context, "LOCK_CONFLICT");
      return { status: "FAILED", resultCode: "LOCK_CONFLICT", exitCode: EXIT.LOCKED };
    case "FAILED":
      if (outcome.exitCode === EXIT.VALIDATION) {
        return context.executionStarted
          ? { status: "FAILED", resultCode: "SQL_ERROR", exitCode: EXIT.VALIDATION }
          : { status: "FAILED", resultCode: "VALIDATION_ERROR", exitCode: EXIT.VALIDATION };
      }
      if (outcome.exitCode === EXIT.RUNTIME) {
        const failureKind = resolveRuntimeFailure(context);
        if (failureKind === "LOCK_UNAVAILABLE") requireExecutionNotStarted(context, failureKind);
        return { status: "FAILED", resultCode: failureKind, exitCode: EXIT.RUNTIME };
      }
      throw invalidOutcome(outcome, "FAILED は Exit 1 または 3 である必要があります");
    case "RUNNING":
    case "SKIPPED":
      throw invalidOutcome(outcome, `${outcome.status} は単一 run の最終 Execution Result に変換できません`);
  }
}

function resolveRuntimeFailure(context: NormalizeExecutionResultContext): RuntimeFailureKind {
  if (context.failureKind !== undefined) return context.failureKind;
  if (errorChainHas(context.cause, LockUnavailableError)) return "LOCK_UNAVAILABLE";
  const status = findHttpStatus(context.cause);
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (
    status !== undefined ||
    isNetworkError(context.cause) ||
    errorChainHas(context.cause, ApiLimitError) ||
    errorChainHas(context.cause, HttpRetryExhaustedError)
  ) {
    return "API_ERROR";
  }
  return "INTERNAL_ERROR";
}

function isFailureResultCode(
  resultCode: KnownResultCode
): resultCode is Exclude<KnownResultCode, "OK" | "NO_DATA"> {
  return resultCode !== "OK" && resultCode !== "NO_DATA";
}

function buildExecutionError(
  resultCode: Exclude<KnownResultCode, "OK" | "NO_DATA">,
  outcome: JobOutcome,
  context: NormalizeExecutionResultContext
): ExecutionResultError {
  const defaults = ERROR_DEFAULTS[resultCode];
  const input = context.error;
  const rawMessage = input?.message ?? outcome.errorMessage ?? defaults.message;
  const masked = context.masker.mask(rawMessage);
  const withoutSqlLiterals = defaults.category === "SQL" ? stripSqlLiterals(masked) : masked;
  const truncated = truncateCharacters(withoutSqlLiterals, EXECUTION_ERROR_MESSAGE_MAX_LENGTH);
  return {
    category: defaults.category,
    code: input?.code?.trim() || errorCodeFor(resultCode, context.cause) || defaults.code,
    message: truncated.value,
    retryable: input?.retryable ?? false,
    detailsTruncated: (input?.detailsTruncated ?? false) || truncated.truncated,
  };
}

function resolveStartedAt(outcome: JobOutcome, context: NormalizeExecutionResultContext): Date | null {
  if (!context.executionStarted) return null;
  const startedAt = context.startedAt;
  if (startedAt == null || Number.isNaN(startedAt.getTime())) {
    throw invalidOutcome(outcome, "executionStarted=true では startedAt が必要です");
  }
  return startedAt;
}

function errorCodeFor(resultCode: KnownResultCode, cause: unknown): string | undefined {
  const status = findHttpStatus(cause);
  if ((resultCode === "AUTH_ERROR" || resultCode === "API_ERROR") && status !== undefined) {
    return `KINTONE_HTTP_${status}`;
  }
  if (resultCode === "API_ERROR") {
    if (errorChainHas(cause, ApiLimitError)) return "API_LIMIT_EXCEEDED";
    if (errorChainHas(cause, HttpRetryExhaustedError)) return "RETRY_EXHAUSTED";
    if (isNetworkError(cause)) return "NETWORK_ERROR";
  }
  return undefined;
}

function errorChainHas<T extends Error>(error: unknown, ctor: new (...args: never[]) => T): boolean {
  let current = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (current instanceof ctor) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function truncateCharacters(value: string, maxLength: number): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return { value, truncated: false };
  return { value: characters.slice(0, maxLength).join(""), truncated: true };
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) throw new Error(`${field} は空にできません`);
  return value;
}

function requireExecutionStarted(context: NormalizeExecutionResultContext, resultCode: KnownResultCode): void {
  if (!context.executionStarted) throw new Error(`${resultCode} では executionStarted=true が必要です`);
}

function requireExecutionNotStarted(context: NormalizeExecutionResultContext, resultCode: KnownResultCode): void {
  if (context.executionStarted) throw new Error(`${resultCode} では executionStarted=false が必要です`);
}

function requireExit(outcome: JobOutcome, exitCode: JobOutcome["exitCode"]): void {
  if (outcome.exitCode !== exitCode) {
    throw invalidOutcome(outcome, `status ${outcome.status} は Exit ${exitCode} である必要があります`);
  }
}

function requireOutcome(
  outcome: JobOutcome,
  status: JobOutcome["status"],
  exitCode: JobOutcome["exitCode"],
  resultCode: KnownResultCode
): void {
  if (outcome.status !== status || outcome.exitCode !== exitCode) {
    throw invalidOutcome(outcome, `${resultCode} は ${status} / Exit ${exitCode} からのみ生成できます`);
  }
}

function invalidOutcome(outcome: JobOutcome, reason: string): Error {
  return new Error(`JobOutcome を Execution Result に正規化できません: ${reason} (${outcome.status}/Exit ${outcome.exitCode})`);
}
