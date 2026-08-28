import * as os from "os";
import { ConfigError } from "./errors";

const HOST_LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** ログアプリ表示用ホスト。ローカルロックはこの値を使わず、実ホスト名を維持する。 */
export function resolveLogHost(env: NodeJS.ProcessEnv = process.env): string {
  const label = env.KSQL_HOST_LABEL;
  if (label === undefined) return os.hostname();
  if (!HOST_LABEL_PATTERN.test(label)) {
    throw new ConfigError(
      "KSQL_HOST_LABEL は 1〜64 文字の [A-Za-z0-9._:-] のみで指定してください"
    );
  }
  return label;
}
