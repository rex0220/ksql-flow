import { ApiLimitError, HttpRetryExhaustedError } from "./errors";
import { ResolvedProfile, RetryConfig } from "./config";

/** リトライ対象の HTTP ステータス（設計書 7.1: API 一時エラー） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

export interface HttpLayerOptions {
  retry: RetryConfig;
  /** 全 HTTP リクエストの上限（単一カウンタ。null で無制限） */
  maxApiCalls: number | null;
  /** 1 試行あたりのタイムアウト(ms) */
  attemptTimeoutMs: number;
  /** Basic 認証の併送（設計書 9.1） */
  basicAuth?: { username: string; password: string };
  /** リトライ待機時の通知（ログ用） */
  onRetryWait?: (info: { attempt: number; delayMs: number; status?: number }) => void;
  /** テスト用の sleep 差し替え */
  sleep?: (ms: number) => Promise<void>;
  /** テスト用の下位 fetch 差し替え（モック kintone） */
  baseFetch?: typeof fetch;
}

export interface HttpLayer {
  fetch: typeof fetch;
  /** これまでの HTTP リクエスト数（リトライの各試行を含む） */
  readonly count: number;
  /** カウンタのスナップショット取得 */
  snapshot(): number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * kintone へ向かう全 HTTP を仲介する fetch ラッパー。
 * - 単一カウンタで API 消費を計上し maxApiCalls を超えるリクエストは発行前に安全停止（設計書 7.2）
 * - 列挙された一時エラー / ネットワークエラーの指数バックオフ + Retry-After 尊重（設計書 7 章）
 */
export function createHttpLayer(options: HttpLayerOptions): HttpLayer {
  const sleep = options.sleep ?? defaultSleep;
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  let count = 0;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    if (options.basicAuth) {
      const encoded = Buffer.from(`${options.basicAuth.username}:${options.basicAuth.password}`).toString("base64");
      headers.set("Authorization", `Basic ${encoded}`);
    }

    const maxAttempts = Math.max(1, options.retry.maxAttempts);
    let lastError: unknown;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.maxApiCalls !== null && count >= options.maxApiCalls) {
        throw new ApiLimitError(options.maxApiCalls);
      }
      count += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.attemptTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      let response: Response | undefined;
      try {
        response = await baseFetch(url, { ...init, headers, signal: controller.signal });
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      if (response !== undefined) {
        if (!RETRYABLE_STATUS.has(response.status)) {
          return response;
        }
        lastStatus = response.status;
        lastError = undefined;
        if (attempt >= maxAttempts) break;
        const delayMs = retryDelayMs(options.retry, attempt, response.headers.get("Retry-After"));
        options.onRetryWait?.({ attempt, delayMs, status: response.status });
        await sleep(delayMs);
        continue;
      }

      // ネットワークエラー / タイムアウト
      if (attempt >= maxAttempts) break;
      const delayMs = retryDelayMs(options.retry, attempt, null);
      options.onRetryWait?.({ attempt, delayMs });
      await sleep(delayMs);
    }

    if (lastStatus !== undefined) {
      throw new HttpRetryExhaustedError(
        `kintone API のリトライ上限 (${maxAttempts} 回) を超過しました (HTTP ${lastStatus})`,
        lastStatus
      );
    }
    throw new HttpRetryExhaustedError(
      `kintone への接続がリトライ上限 (${maxAttempts} 回) まで失敗しました`,
      undefined,
      lastError
    );
  };

  return {
    fetch: wrapped as typeof fetch,
    get count() {
      return count;
    },
    snapshot: () => count,
  };
}

function retryDelayMs(retry: RetryConfig, attempt: number, retryAfter: string | null): number {
  if (retry.respectRetryAfter && retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, retry.maxDelayMs);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), retry.maxDelayMs);
  }
  const base = retry.initialDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(base, retry.maxDelayMs);
  // full jitter
  return Math.floor(Math.random() * capped);
}

/** エンジン client 生成に使う共通設定を組み立てる */
export function engineClientConfig(profile: ResolvedProfile, http: HttpLayer): {
  baseUrl: string;
  guestSpaceId?: number;
  auth: { type: "apiToken"; apiToken: (appId: number) => string } | { type: "password"; username: string; password: string };
  fetch: typeof fetch;
  timeoutMs: number;
} {
  return {
    baseUrl: profile.baseUrl,
    ...(profile.guestSpaceId !== undefined ? { guestSpaceId: profile.guestSpaceId } : {}),
    auth:
      profile.auth.type === "password"
        ? { type: "password", username: profile.auth.username!, password: profile.auth.password! }
        : { type: "apiToken", apiToken: requireTokenResolver(profile) },
    fetch: http.fetch,
    // 試行単位のタイムアウトはラッパー側で管理するため、エンジン側は十分大きくする
    // （エンジンの timeoutMs はリトライを含む fetch 全体を包むため。調査報告 §4-1）
    timeoutMs: 24 * 60 * 60 * 1000,
  };
}

function requireTokenResolver(profile: ResolvedProfile): (appId: number) => string {
  // 遅延 import を避けるためここで簡易実装（config.tokenByAppId と同一仕様）
  const byId = new Map<number, string>();
  for (const def of Object.values(profile.apps)) byId.set(def.id, def.tokens.join(","));
  return (appId: number) => {
    const token = byId.get(appId);
    if (token === undefined || token === "") {
      throw new Error(`アプリ ID ${appId} の API トークンが config の apps に定義されていません`);
    }
    return token;
  };
}
