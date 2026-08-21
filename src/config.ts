import * as fs from "fs";
import * as path from "path";
import { ConfigError } from "./errors";

/** kintone の 1 リクエストに付与できる API トークン上限（設計書 9.1） */
const MAX_TOKENS_PER_APP = 9;

export interface AppDef {
  id: number;
  /** env: 解決済みトークン */
  tokens: string[];
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  respectRetryAfter: boolean;
}

export interface LimitsConfig {
  maxApiCalls: number | null;
  maxTempRows: number | null;
  batchTimeoutSec: number | null;
}

export interface LoggingConfig {
  localDir: string;
  maskFields: string[];
  stripLiterals: boolean;
}

export interface NotificationsConfig {
  onFailure?: { webhook: string };
  heartbeat?: { url: string; on: "success" | "always" };
}

export interface AuthConfig {
  type: "apiToken" | "password";
  username?: string;
  password?: string;
}

export interface ResolvedProfile {
  name: string;
  baseUrl: string;
  timezone?: string;
  auth: AuthConfig;
  /** Basic 認証の併送（設計書 9.1 の auth.type: basic 相当。他方式と併用可） */
  basicAuth?: { username: string; password: string };
  clientCert?: { pfxPath: string; password: string };
  proxy?: string;
  guestSpaceId?: number;
  /** 論理アプリ名 → 定義。extends では継承されない（設計書 9 章） */
  apps: Record<string, AppDef>;
  /** ログアプリの論理名（apps 内に定義必須）。extends では継承されない */
  logApp?: string;
  limits: LimitsConfig;
  retry: RetryConfig;
  notifications: NotificationsConfig;
  logging: LoggingConfig;
  /** HTTP 1 試行あたりのタイムアウト(ms) */
  httpTimeoutMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  respectRetryAfter: true,
};

export const DEFAULT_LIMITS: LimitsConfig = {
  maxApiCalls: null,
  maxTempRows: null,
  batchTimeoutSec: 3600,
};

export const DEFAULT_LOGGING: LoggingConfig = {
  localDir: ".ksql/logs",
  maskFields: [],
  stripLiterals: false,
};

/** "env:VAR" 形式の参照を解決する。未定義の環境変数は ConfigError。 */
export function resolveEnvRef(value: string, context: string): string {
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const resolved = process.env[name];
  if (resolved === undefined || resolved === "") {
    throw new ConfigError(`${context}: 環境変数 ${name} が設定されていません`);
  }
  return resolved;
}

interface RawConfig {
  defaultProfile?: unknown;
  profiles?: Record<string, RawProfile>;
  limits?: unknown;
  retry?: unknown;
  notifications?: unknown;
  logging?: unknown;
}

interface RawProfile {
  extends?: unknown;
  baseUrl?: unknown;
  timezone?: unknown;
  auth?: unknown;
  basicAuth?: unknown;
  clientCert?: unknown;
  proxy?: unknown;
  guestSpaceId?: unknown;
  apps?: unknown;
  logApp?: unknown;
  limits?: unknown;
  retry?: unknown;
  notifications?: unknown;
  logging?: unknown;
  httpTimeoutMs?: unknown;
}

export interface LoadConfigOptions {
  configPath?: string;
  profile?: string;
  cwd?: string;
}

export function findConfigPath(opts: LoadConfigOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  const candidate = opts.configPath ?? path.join(cwd, "ksql.config.json");
  if (!fs.existsSync(candidate)) {
    throw new ConfigError(`設定ファイルが見つかりません: ${candidate}`);
  }
  return candidate;
}

export function loadConfig(opts: LoadConfigOptions = {}): ResolvedProfile {
  const configPath = findConfigPath(opts);
  let raw: RawConfig;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as RawConfig;
  } catch (error) {
    throw new ConfigError(`設定ファイルの JSON 解析に失敗しました (${configPath}): ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || typeof raw.profiles !== "object" || raw.profiles === null) {
    throw new ConfigError(`設定ファイルに profiles がありません (${configPath})`);
  }
  const profileName = opts.profile
    ?? (typeof raw.defaultProfile === "string" ? raw.defaultProfile : undefined);
  if (!profileName) {
    throw new ConfigError("プロファイルが指定されていません（--profile または defaultProfile）");
  }
  const merged = mergeProfileChain(raw, profileName);
  return resolveProfile(raw, merged, profileName);
}

/** extends チェーンをたどってマージする。apps / logApp は継承しない（設計書 9 章の事故防止規定）。 */
function mergeProfileChain(raw: RawConfig, name: string): RawProfile {
  const chain: RawProfile[] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current !== undefined) {
    if (seen.has(current)) {
      throw new ConfigError(`profiles.${name}: extends が循環しています (${[...seen].join(" -> ")} -> ${current})`);
    }
    seen.add(current);
    const profile: RawProfile | undefined = raw.profiles?.[current];
    if (profile === undefined) {
      throw new ConfigError(`プロファイル ${current} が定義されていません`);
    }
    chain.unshift(profile);
    current = typeof profile.extends === "string" ? profile.extends : undefined;
  }
  const merged: RawProfile = {};
  for (const layer of chain) {
    for (const [key, value] of Object.entries(layer)) {
      if (key === "extends") continue;
      // apps / logApp は「自プロファイルで定義した場合のみ」有効（親からの継承は不可）
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  const own = raw.profiles?.[name] ?? {};
  merged.apps = own.apps;
  merged.logApp = own.logApp;
  return merged;
}

function resolveProfile(raw: RawConfig, profile: RawProfile, name: string): ResolvedProfile {
  const ctx = `profiles.${name}`;
  if (typeof profile.baseUrl !== "string" || profile.baseUrl === "") {
    throw new ConfigError(`${ctx}.baseUrl が必要です`);
  }
  const baseUrl = resolveEnvRef(profile.baseUrl, `${ctx}.baseUrl`);
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw new ConfigError(`${ctx}.baseUrl が URL として不正です: ${baseUrl}`);
  }

  if (profile.timezone !== undefined && typeof profile.timezone !== "string") {
    throw new ConfigError(`${ctx}.timezone は文字列で指定してください`);
  }
  const timezone = profile.timezone as string | undefined;
  if (timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new ConfigError(`${ctx}.timezone が IANA タイムゾーン名として不正です: ${timezone}`);
    }
  }

  const auth = resolveAuth(profile, ctx);
  const basicAuth = resolveBasicAuth(profile, ctx);
  const apps = resolveApps(profile.apps, ctx);

  let logApp: string | undefined;
  if (profile.logApp !== undefined) {
    if (typeof profile.logApp !== "string" || profile.logApp === "") {
      throw new ConfigError(`${ctx}.logApp は論理アプリ名の文字列で指定してください`);
    }
    logApp = profile.logApp;
    if (apps[logApp] === undefined) {
      throw new ConfigError(`${ctx}.logApp "${logApp}" が ${ctx}.apps に定義されていません`);
    }
  }

  let clientCert: ResolvedProfile["clientCert"];
  if (profile.clientCert !== undefined) {
    const cert = profile.clientCert as { pfxPath?: unknown; password?: unknown };
    if (typeof cert !== "object" || cert === null || typeof cert.pfxPath !== "string") {
      throw new ConfigError(`${ctx}.clientCert.pfxPath が必要です`);
    }
    clientCert = {
      pfxPath: cert.pfxPath,
      password: typeof cert.password === "string" ? resolveEnvRef(cert.password, `${ctx}.clientCert.password`) : "",
    };
    throw new ConfigError(
      `${ctx}.clientCert は現バージョンでは未対応です。安全のため設定を削除してから再実行してください`
    );
  }

  let proxy: string | undefined;
  if (profile.proxy !== undefined && profile.proxy !== null) {
    if (typeof profile.proxy !== "string") throw new ConfigError(`${ctx}.proxy は文字列で指定してください`);
    proxy = resolveEnvRef(profile.proxy, `${ctx}.proxy`);
    throw new ConfigError(
      `${ctx}.proxy は現バージョンでは未対応です。安全のため設定を削除してから再実行してください`
    );
  }

  let guestSpaceId: number | undefined;
  if (profile.guestSpaceId !== undefined && profile.guestSpaceId !== null) {
    if (typeof profile.guestSpaceId !== "number" || !Number.isSafeInteger(profile.guestSpaceId) || profile.guestSpaceId <= 0) {
      throw new ConfigError(`${ctx}.guestSpaceId は正の整数で指定してください`);
    }
    guestSpaceId = profile.guestSpaceId;
  }

  const limits = resolveLimits(profile.limits ?? raw.limits, ctx);
  const retry = resolveRetry(profile.retry ?? raw.retry, ctx);
  const notifications = resolveNotifications(profile.notifications ?? raw.notifications, ctx);
  const logging = resolveLogging(profile.logging ?? raw.logging, ctx);

  let httpTimeoutMs = 30000;
  if (profile.httpTimeoutMs !== undefined) {
    if (typeof profile.httpTimeoutMs !== "number" || profile.httpTimeoutMs <= 0) {
      throw new ConfigError(`${ctx}.httpTimeoutMs は正の数で指定してください`);
    }
    httpTimeoutMs = profile.httpTimeoutMs;
  }

  return {
    name,
    baseUrl,
    timezone,
    auth,
    basicAuth,
    clientCert,
    proxy,
    guestSpaceId,
    apps,
    logApp,
    limits,
    retry,
    notifications,
    logging,
    httpTimeoutMs,
  };
}

function resolveAuth(profile: RawProfile, ctx: string): AuthConfig {
  const rawAuth = (profile.auth ?? { type: "apiToken" }) as { type?: unknown; username?: unknown; password?: unknown };
  if (typeof rawAuth !== "object" || rawAuth === null || typeof rawAuth.type !== "string") {
    throw new ConfigError(`${ctx}.auth.type が必要です (apiToken / password / basic)`);
  }
  const type = rawAuth.type;
  if (type === "apiToken") return { type: "apiToken" };
  if (type === "password" || type === "basic") {
    if (typeof rawAuth.username !== "string" || typeof rawAuth.password !== "string") {
      throw new ConfigError(`${ctx}.auth: type "${type}" には username / password が必要です`);
    }
    return {
      type: "password",
      username: resolveEnvRef(rawAuth.username, `${ctx}.auth.username`),
      password: resolveEnvRef(rawAuth.password, `${ctx}.auth.password`),
    };
  }
  throw new ConfigError(`${ctx}.auth.type が不正です: ${type} (apiToken / password / basic)`);
}

function resolveBasicAuth(profile: RawProfile, ctx: string): ResolvedProfile["basicAuth"] {
  const authType = (profile.auth as { type?: unknown } | undefined)?.type;
  let rawBasic = profile.basicAuth as { username?: unknown; password?: unknown } | undefined;
  if (authType === "basic" && rawBasic === undefined) {
    const auth = profile.auth as { basicUsername?: unknown; basicPassword?: unknown };
    if (typeof auth.basicUsername === "string" && typeof auth.basicPassword === "string") {
      rawBasic = { username: auth.basicUsername, password: auth.basicPassword };
    } else {
      throw new ConfigError(`${ctx}.auth: type "basic" には basicUsername / basicPassword（または ${ctx}.basicAuth）が必要です`);
    }
  }
  if (rawBasic === undefined) return undefined;
  if (typeof rawBasic.username !== "string" || typeof rawBasic.password !== "string") {
    throw new ConfigError(`${ctx}.basicAuth には username / password が必要です`);
  }
  return {
    username: resolveEnvRef(rawBasic.username, `${ctx}.basicAuth.username`),
    password: resolveEnvRef(rawBasic.password, `${ctx}.basicAuth.password`),
  };
}

function resolveApps(rawApps: unknown, ctx: string): Record<string, AppDef> {
  if (rawApps === undefined) return {};
  if (typeof rawApps !== "object" || rawApps === null) {
    throw new ConfigError(`${ctx}.apps はオブジェクトで指定してください`);
  }
  const apps: Record<string, AppDef> = {};
  for (const [name, def] of Object.entries(rawApps as Record<string, unknown>)) {
    if (typeof def !== "object" || def === null) {
      throw new ConfigError(`${ctx}.apps.${name} はオブジェクトで指定してください`);
    }
    const { id, tokens } = def as { id?: unknown; tokens?: unknown };
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new ConfigError(`${ctx}.apps.${name}.id は正の整数で指定してください`);
    }
    let resolvedTokens: string[] = [];
    if (tokens !== undefined) {
      if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== "string")) {
        throw new ConfigError(`${ctx}.apps.${name}.tokens は文字列の配列で指定してください`);
      }
      if (tokens.length > MAX_TOKENS_PER_APP) {
        throw new ConfigError(`${ctx}.apps.${name}.tokens は最大 ${MAX_TOKENS_PER_APP} 個までです (kintone の上限)`);
      }
      resolvedTokens = (tokens as string[]).map((token, index) =>
        resolveEnvRef(token, `${ctx}.apps.${name}.tokens[${index}]`)
      );
    }
    apps[name] = { id, tokens: resolvedTokens };
  }
  return apps;
}

function resolveLimits(raw: unknown, ctx: string): LimitsConfig {
  if (raw === undefined) return { ...DEFAULT_LIMITS };
  if (typeof raw !== "object" || raw === null) throw new ConfigError(`${ctx}.limits はオブジェクトで指定してください`);
  const value = raw as Record<string, unknown>;
  const positiveOrNull = (key: string): number | null => {
    const item = value[key];
    if (item === undefined || item === null) return DEFAULT_LIMITS[key as keyof LimitsConfig];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new ConfigError(`limits.${key} は正の整数で指定してください`);
    }
    return item;
  };
  return {
    maxApiCalls: positiveOrNull("maxApiCalls"),
    maxTempRows: positiveOrNull("maxTempRows"),
    batchTimeoutSec: positiveOrNull("batchTimeoutSec"),
  };
}

function resolveRetry(raw: unknown, _ctx: string): RetryConfig {
  if (raw === undefined) return { ...DEFAULT_RETRY };
  if (typeof raw !== "object" || raw === null) throw new ConfigError("retry はオブジェクトで指定してください");
  const value = raw as Record<string, unknown>;
  const num = (key: keyof RetryConfig, fallback: number): number => {
    const item = value[key];
    if (item === undefined) return fallback;
    if (typeof item !== "number" || item < 0) throw new ConfigError(`retry.${key} は 0 以上の数で指定してください`);
    return item;
  };
  const bool = (key: keyof RetryConfig, fallback: boolean): boolean => {
    const item = value[key];
    if (item === undefined) return fallback;
    if (typeof item !== "boolean") throw new ConfigError(`retry.${key} は true/false で指定してください`);
    return item;
  };
  return {
    maxAttempts: num("maxAttempts", DEFAULT_RETRY.maxAttempts),
    initialDelayMs: num("initialDelayMs", DEFAULT_RETRY.initialDelayMs),
    maxDelayMs: num("maxDelayMs", DEFAULT_RETRY.maxDelayMs),
    respectRetryAfter: bool("respectRetryAfter", DEFAULT_RETRY.respectRetryAfter),
  };
}

function resolveNotifications(raw: unknown, ctx: string): NotificationsConfig {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) throw new ConfigError("notifications はオブジェクトで指定してください");
  const value = raw as { onFailure?: { webhook?: unknown }; heartbeat?: { url?: unknown; on?: unknown } };
  const result: NotificationsConfig = {};
  if (value.onFailure !== undefined) {
    if (typeof value.onFailure.webhook !== "string") {
      throw new ConfigError("notifications.onFailure.webhook が必要です");
    }
    result.onFailure = {
      webhook: resolveEnvRef(value.onFailure.webhook, `${ctx}.notifications.onFailure.webhook`),
    };
  }
  if (value.heartbeat !== undefined) {
    if (typeof value.heartbeat.url !== "string") throw new ConfigError("notifications.heartbeat.url が必要です");
    const on = value.heartbeat.on ?? "success";
    if (on !== "success" && on !== "always") throw new ConfigError('notifications.heartbeat.on は "success" / "always" で指定してください');
    result.heartbeat = {
      url: resolveEnvRef(value.heartbeat.url, `${ctx}.notifications.heartbeat.url`),
      on,
    };
  }
  return result;
}

function resolveLogging(raw: unknown, _ctx: string): LoggingConfig {
  if (raw === undefined) return { ...DEFAULT_LOGGING };
  if (typeof raw !== "object" || raw === null) throw new ConfigError("logging はオブジェクトで指定してください");
  const value = raw as { localDir?: unknown; maskFields?: unknown; stripLiterals?: unknown };
  if (value.localDir !== undefined && typeof value.localDir !== "string") {
    throw new ConfigError("logging.localDir は文字列で指定してください");
  }
  if (value.maskFields !== undefined && (!Array.isArray(value.maskFields) || value.maskFields.some((field) => typeof field !== "string"))) {
    throw new ConfigError("logging.maskFields は文字列の配列で指定してください");
  }
  if (value.stripLiterals !== undefined && typeof value.stripLiterals !== "boolean") {
    throw new ConfigError("logging.stripLiterals は true/false で指定してください");
  }
  return {
    localDir: (value.localDir as string | undefined) ?? DEFAULT_LOGGING.localDir,
    maskFields: (value.maskFields as string[] | undefined) ?? [],
    stripLiterals: (value.stripLiterals as boolean | undefined) ?? false,
  };
}

/** 論理アプリ名 → アプリ ID のマップ（エンジンの apps オプション形式） */
export function appIdMap(profile: ResolvedProfile): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [name, def] of Object.entries(profile.apps)) map[name] = def.id;
  return map;
}

/** アプリ ID → カンマ結合済みトークン（設計書 9.1: 対象アプリの tokens のみを結合して送る） */
export function tokenByAppId(profile: ResolvedProfile): (appId: number) => string {
  const byId = new Map<number, string>();
  for (const def of Object.values(profile.apps)) {
    byId.set(def.id, def.tokens.join(","));
  }
  return (appId: number) => {
    const token = byId.get(appId);
    if (token === undefined || token === "") {
      throw new ConfigError(
        `アプリ ID ${appId} の API トークンが config の apps に定義されていません`
      );
    }
    return token;
  };
}
