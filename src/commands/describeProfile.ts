import type { ResolvedProfile } from "../config";
import { EXIT, type ExitCode } from "../types";
import { writeJsonObject } from "./machineJson";

/**
 * 解決済み profile から非秘密フィールドだけを新しい object へコピーする。
 * ResolvedProfile 自体を spread / serialize しないことが秘密非混入の構造的保証になる。
 */
export function describeProfileCommand(profile: ResolvedProfile): ExitCode {
  const apps: Record<string, number> = {};
  for (const [name, app] of Object.entries(profile.apps)) apps[name] = app.id;
  const logApp = profile.logApp === undefined
    ? null
    : { name: profile.logApp, appId: profile.apps[profile.logApp].id };

  writeJsonObject({
    formatVersion: 1,
    kind: "PROFILE_DESCRIPTION",
    profile: profile.name,
    baseUrl: normalizeBaseUrl(profile.baseUrl),
    guestSpaceId: profile.guestSpaceId ?? null,
    timezone: profile.timezone ?? null,
    apps,
    logApp,
    limits: {
      maxApiCalls: profile.limits.maxApiCalls,
      maxReadRows: profile.limits.maxReadRows,
      maxTempRows: profile.limits.maxTempRows,
      batchTimeoutSec: profile.limits.batchTimeoutSec,
    },
    retry: {
      maxAttempts: profile.retry.maxAttempts,
      initialDelayMs: profile.retry.initialDelayMs,
      maxDelayMs: profile.retry.maxDelayMs,
      respectRetryAfter: profile.retry.respectRetryAfter,
    },
    httpTimeoutMs: profile.httpTimeoutMs,
  }, true);
  return EXIT.OK;
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/+$/, "");
}
