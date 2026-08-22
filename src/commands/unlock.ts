import { ResolvedProfile } from "../config";
import { errorMessage } from "../errors";
import { LocalLock } from "../lock";
import { RunningRecord } from "../logapp";
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

  let running: RunningRecord[] = [];
  if (env.logApp !== null) {
    try {
      running = await env.logApp.listRunning(profile.name);
      printRunningTargets(out, profile.name, running, "unlock");
    } catch (error) {
      out(`エラー: 解除対象 RUNNING レコードの取得に失敗しました。何も解除しません: ${errorMessage(error)}`);
      return EXIT.RUNTIME;
    }
  } else {
    out(`解除範囲: 同一プロファイル "${profile.name}" の全 RUNNING（logApp 未設定のため対象確認不可）`);
  }

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

export function printRunningTargets(
  out: (line: string) => void,
  profileName: string,
  running: RunningRecord[],
  operation: "unlock" | "--force-unlock"
): void {
  out(`解除範囲: ${operation} は同一プロファイル "${profileName}" の全 RUNNING を対象にします`);
  out(`解除対象 RUNNING: ${running.length} 件`);
  for (const record of running) {
    out(`  - jobKey=${record.jobKey || "(job_key なし)"}, 開始=${record.startedAt ?? "(不明)"}`);
  }
}
