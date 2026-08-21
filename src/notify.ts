import { ResolvedProfile } from "./config";
import { errorMessage } from "./errors";
import { SecretMasker } from "./logging/mask";
import { BatchOutcome, JobOutcome } from "./types";

/**
 * Webhook 通知（設計書 7.3 / 12 章）。
 * 通信先は利用者が設定した URL のみ。kintone API カウンタの対象外。
 * 通知の失敗は実行結果に影響させない（警告表示のみ）。
 */
export interface NotifyDeps {
  fetchImpl?: typeof fetch;
  out?: (line: string) => void;
}

const NOTIFY_TIMEOUT_MS = 10_000;

async function post(url: string, payload: unknown, deps: NotifyDeps): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Webhook が HTTP ${response.status} を返しました`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 失敗通知（onFailure）。NO_DATA では呼ばないこと（設計書 3.2 / 受入基準 2） */
export async function notifyFailure(
  profile: ResolvedProfile,
  masker: SecretMasker,
  payload: {
    kind: "job" | "batch";
    batchId: string;
    status: string;
    exitCode: number;
    asOf: string;
    jobs: JobOutcome[];
  },
  deps: NotifyDeps = {}
): Promise<void> {
  const webhook = profile.notifications.onFailure?.webhook;
  if (webhook === undefined) return;
  const body = {
    source: "ksql-flow",
    profile: profile.name,
    kind: payload.kind,
    batch_id: payload.batchId,
    status: payload.status,
    exit_code: payload.exitCode,
    as_of: payload.asOf,
    jobs: payload.jobs.map((job) => ({
      name: job.jobName,
      script: job.scriptName,
      status: job.status,
      error: job.errorMessage !== undefined ? masker.mask(job.errorMessage) : null,
    })),
    // Slack 等の汎用受信も考慮した簡易テキスト
    text: masker.mask(
      `[ksql-flow] ${profile.name}: ${payload.status} (exit ${payload.exitCode})\n` +
        payload.jobs
          .filter((job) => job.status !== "SUCCESS" && job.status !== "NO_DATA")
          .map((job) => `- ${job.scriptName}: ${job.status}${job.errorMessage ? ` — ${job.errorMessage}` : ""}`)
          .join("\n")
    ),
  };
  try {
    await post(webhook, body, deps);
  } catch (error) {
    deps.out?.(`警告: 失敗通知 Webhook の送信に失敗しました: ${masker.mask(errorMessage(error))}`);
  }
}

/** heartbeat（設計書 7.3）。Exit 0（SUCCESS / NO_DATA）の完了時に送る */
export async function notifyHeartbeat(
  profile: ResolvedProfile,
  masker: SecretMasker,
  payload: { batchId: string; status: string },
  deps: NotifyDeps = {}
): Promise<void> {
  const heartbeat = profile.notifications.heartbeat;
  if (heartbeat === undefined) return;
  try {
    await post(heartbeat.url, {
      source: "ksql-flow",
      profile: profile.name,
      batch_id: payload.batchId,
      status: payload.status,
      ts: new Date().toISOString(),
    }, deps);
  } catch (error) {
    deps.out?.(`警告: heartbeat の送信に失敗しました: ${masker.mask(errorMessage(error))}`);
  }
}

export function batchNotifyPayload(batch: BatchOutcome): {
  kind: "batch";
  batchId: string;
  status: string;
  exitCode: number;
  asOf: string;
  jobs: JobOutcome[];
} {
  return {
    kind: "batch",
    batchId: batch.batchId,
    status: batch.status,
    exitCode: batch.exitCode,
    asOf: batch.asOf.toISOString(),
    jobs: batch.jobs,
  };
}
