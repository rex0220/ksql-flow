import { ResolvedProfile } from "../config";
import { errorMessage } from "../errors";
import { LocalLock } from "../lock";
import { createRunnerEnv } from "../runner";
import { EXIT, ExitCode } from "../types";

/**
 * unlock コマンド（設計書 5.5-5 / タスク指示書 E）。
 * ハングした前回セッションのローカルロックとログアプリ RUNNING レコードを明示解除する。
 * 解除の事実は log_detail と JSONL に記録される。
 */
export async function unlockCommand(
  profile: ResolvedProfile,
  options: { baseFetch?: typeof fetch; out?: (line: string) => void } = {}
): Promise<ExitCode> {
  const env = createRunnerEnv(profile, { baseFetch: options.baseFetch, out: options.out });
  const out = env.out;
  let hadError = false;

  const localLock = new LocalLock(process.cwd(), profile.name);
  const existing = localLock.read();
  if (existing !== null) {
    if (localLock.forceRelease()) {
      out(`ローカルロックを解除しました (pid=${existing.pid}, 開始=${existing.startedAt})`);
      env.jsonl.append("unlock_local", { pid: existing.pid, startedAt: existing.startedAt });
    }
  } else {
    out("ローカルロックはありません");
  }

  if (env.logApp !== null) {
    try {
      const running = await env.logApp.listRunning(profile.name);
      if (running.length === 0) {
        out("ログアプリに RUNNING レコードはありません");
      }
      for (const record of running) {
        await env.logApp.recoverStale(record, "ksql-flow unlock による明示解除");
        out(`RUNNING レコードを解除しました: ${record.jobKey || "(job_key なし)"} (レコード ${record.id})`);
      }
    } catch (error) {
      out(`エラー: ログアプリのロック解除に失敗しました: ${errorMessage(error)}`);
      hadError = true;
    }
  } else {
    out("logApp が設定されていないため、分散ロックの解除はスキップしました");
  }

  return hadError ? EXIT.RUNTIME : EXIT.OK;
}
