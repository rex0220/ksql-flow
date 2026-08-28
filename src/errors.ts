import { EXIT, ExitCode } from "./types";

/** 設定・検証系の失敗（Exit 1） */
export class ConfigError extends Error {
  readonly exitCode: ExitCode = EXIT.VALIDATION;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 多重起動検知（Exit 5） */
export class LockedError extends Error {
  readonly exitCode: ExitCode = EXIT.LOCKED;
  constructor(message: string) {
    super(message);
    this.name = "LockedError";
  }
}

/** 分散ロックを確立できない fail-closed（Exit 3・理由 LOCK_UNAVAILABLE。設計書 5.5-4） */
export class LockUnavailableError extends Error {
  readonly exitCode: ExitCode = EXIT.RUNTIME;
  readonly reason = "LOCK_UNAVAILABLE";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LockUnavailableError";
  }
}

/** ログアプリの読取応答が契約を満たさない fail-closed（Exit 3） */
export class LogAppResponseError extends Error {
  readonly exitCode: ExitCode = EXIT.RUNTIME;
  constructor(message: string) {
    super(message);
    this.name = "LogAppResponseError";
  }
}

/** maxApiCalls 超過による安全停止（Exit 3。設計書 7.2） */
export class ApiLimitError extends Error {
  readonly exitCode: ExitCode = EXIT.RUNTIME;
  constructor(readonly limit: number) {
    super(`API 消費回数が上限 (maxApiCalls=${limit}) に達したため安全停止しました`);
    this.name = "ApiLimitError";
  }
}

/** dry-run 中に kintone の変更系 HTTP が発行されようとした場合の多重防壁。 */
export class DryRunMutationError extends Error {
  readonly exitCode: ExitCode = EXIT.RUNTIME;
  constructor(readonly method: string, readonly path: string) {
    super(`dry-run の副作用ゼロガードが変更系リクエストを遮断しました (${method} ${path})`);
    this.name = "DryRunMutationError";
  }
}

/** リトライ上限超過・ネットワーク断（Exit 3） */
export class HttpRetryExhaustedError extends Error {
  readonly exitCode: ExitCode = EXIT.RUNTIME;
  constructor(message: string, readonly status?: number, readonly cause?: unknown) {
    super(message);
    this.name = "HttpRetryExhaustedError";
  }
}

/** cause チェーンから HTTP status を探す（エンジン内部の KintoneHttpError は status プロパティを持つ） */
export function findHttpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (typeof current === "object") {
      const status = (current as { status?: unknown }).status;
      if (typeof status === "number") return status;
      current = (current as { cause?: unknown }).cause;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 実行時エラーの Exit Code 分類（タスク指示書 §3 / 設計書 7.1）:
 * HTTP / ネットワーク / 認証 / リトライ上限 / API 上限 → 3、それ以外（SQL 構文・検証・実行時 SQL エラー）→ 1。
 */
export function classifyRuntimeError(error: unknown): ExitCode {
  if (errorChainHas(error, ApiLimitError) || errorChainHas(error, HttpRetryExhaustedError)) return EXIT.RUNTIME;
  if (errorChainHas(error, DryRunMutationError)) return EXIT.RUNTIME;
  if (errorChainHas(error, LockUnavailableError)) return EXIT.RUNTIME;
  if (errorChainHas(error, LogAppResponseError)) return EXIT.RUNTIME;
  if (errorChainHas(error, LockedError)) return EXIT.LOCKED;
  if (errorChainHas(error, ConfigError)) return EXIT.VALIDATION;
  if (findHttpStatus(error) !== undefined) return EXIT.RUNTIME;
  if (isNetworkError(error)) return EXIT.RUNTIME;
  return EXIT.VALIDATION;
}

function errorChainHas<T extends Error>(error: unknown, ctor: new (...args: never[]) => T): boolean {
  let current = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (current instanceof ctor) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** fetch のネットワーク例外（TypeError）/ Abort を判定 */
export function isNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (current instanceof TypeError) return true;
    if (typeof current === "object" && (current as { name?: unknown }).name === "AbortError") return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** 例外 → 表示用メッセージ（認証情報を含めない。Error.message のみを使い、ヘッダ等は構造的に含まれない） */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
