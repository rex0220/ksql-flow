import * as crypto from "crypto";
import { createKintoneClient } from "@rex0220/kintone-sql-tools/flow";
import { ResolvedProfile } from "./config";
import { ConfigError } from "./errors";
import { RunnerEnv } from "./executor";
import { createHttpLayer, engineClientConfig } from "./http";
import { LogAppClient } from "./logapp";
import { JsonlLogger, PendingQueue } from "./logging/jsonl";
import { SecretMasker } from "./logging/mask";

export interface CreateEnvOptions {
  batchId?: string;
  maxApiCallsOverride?: number;
  lockLocalOnly?: boolean;
  baseFetch?: typeof fetch;
  out?: (line: string) => void;
  dryRun?: boolean;
  json?: boolean;
}

export interface RunnerEnvBundle extends RunnerEnv {
  batchId: string;
  pending: PendingQueue;
}

/** コマンド共通のランナー環境を組み立てる（HTTP 層は単一カウンタで共有） */
export function createRunnerEnv(profile: ResolvedProfile, options: CreateEnvOptions = {}): RunnerEnvBundle {
  const batchId = options.batchId ?? crypto.randomUUID();
  const masker = new SecretMasker(profile);
  const out = options.out ?? ((line: string) => console.log(masker.mask(line)));
  const jsonl = new JsonlLogger(profile.logging.localDir, batchId, profile.name, masker);
  const pending = new PendingQueue(profile.logging.localDir, masker);

  let maxApiCalls = profile.limits.maxApiCalls;
  if (options.maxApiCallsOverride !== undefined) {
    if (!Number.isSafeInteger(options.maxApiCallsOverride) || options.maxApiCallsOverride <= 0) {
      throw new ConfigError(`--max-api-calls は正の整数で指定してください`);
    }
    maxApiCalls = options.maxApiCallsOverride;
  }

  // 手組みの ResolvedProfile でも、未対応オプションを受理して直結通信へ落とさない。
  if (profile.clientCert !== undefined) {
    throw new ConfigError("clientCert は現バージョンでは未対応です。安全のため設定を削除してから再実行してください");
  }
  if (profile.proxy !== undefined) {
    throw new ConfigError("proxy は現バージョンでは未対応です。安全のため設定を削除してから再実行してください");
  }

  const http = createHttpLayer({
    retry: profile.retry,
    maxApiCalls,
    attemptTimeoutMs: profile.httpTimeoutMs,
    basicAuth: profile.basicAuth,
    baseFetch: options.baseFetch,
    dryRun: options.dryRun,
    onRetryWait: (info) => {
      if (options.json === true) return;
      out(
        `  リトライ待機: ${Math.round(info.delayMs / 100) / 10} 秒後に再試行 (試行 ${info.attempt}${
          info.status !== undefined ? ` / HTTP ${info.status}` : " / ネットワークエラー"
        })`
      );
    },
  });

  const client = createKintoneClient(engineClientConfig(profile, http));
  const logApp =
    profile.logApp !== undefined
      ? new LogAppClient(client, profile.apps[profile.logApp].id, jsonl, pending, out)
      : null;

  return {
    profile,
    http,
    client,
    logApp,
    jsonl,
    masker,
    out,
    batchId,
    pending,
    lockLocalOnly: options.lockLocalOnly ?? false,
  };
}

/** --as-of の解析（ISO 8601）。不正は ConfigError（Exit 1） */
export function parseAsOf(value: string | undefined): Date {
  if (value === undefined) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConfigError(`--as-of の日時が解析できません: ${value}（例: 2026-08-01T00:00:00+09:00）`);
  }
  return parsed;
}

/** ジョブ timeout とバッチ残り時間から実効タイムアウトを決める */
export function effectiveTimeoutMs(
  jobTimeoutSec: number | null,
  batchDeadline: number | null
): number | null {
  const candidates: number[] = [];
  if (jobTimeoutSec !== null) candidates.push(jobTimeoutSec * 1000);
  if (batchDeadline !== null) candidates.push(Math.max(1, batchDeadline - Date.now()));
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}
