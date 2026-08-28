import { ConfigError } from "./errors";

// 2026-08-28 kintone 実機測定: 重複禁止の文字列 1 行フィールドは
// 64 UTF-16 コード単位まで受理し、65 以上は 400 CB_VA01 で拒否された。
export const MAX_JOB_KEY_LENGTH = 64;

const BATCH_JOB_NAME = "__batch__";

/** 通常ジョブの分散ロックキーを検査し、従来形式 {profile}:{name} で返す。 */
export function buildJobKey(profileName: string, jobName: string): string {
  return build(profileName, jobName, false);
}

/** run-all の内部バッチロックキーを、通常ジョブと同じ制約・形式で返す。 */
export function buildBatchJobKey(profileName: string): string {
  return build(profileName, BATCH_JOB_NAME, true);
}

function build(profileName: string, jobName: string, allowBatchName: boolean): string {
  if (profileName.includes(":")) {
    throw new ConfigError(
      `プロファイル名 "${profileName}" に ":" は使用できません。ksql.config.json の profiles で別名に変更してください`
    );
  }
  if (jobName.includes(":")) {
    throw new ConfigError(
      `ジョブ名 "${jobName}" に ":" は使用できません。ジョブファイルの @ksql name で別名を指定してください`
    );
  }
  if (!allowBatchName && jobName === BATCH_JOB_NAME) {
    throw new ConfigError(
      `ジョブ名 "${BATCH_JOB_NAME}" は run-all のバッチロック用予約語です。ジョブファイルの @ksql name で別名を指定してください`
    );
  }

  const key = `${profileName}:${jobName}`;
  // String#length は kintone 実測と一致する UTF-16 コード単位を返す。
  if (key.length > MAX_JOB_KEY_LENGTH) {
    const action = allowBatchName
      ? "ksql.config.json のプロファイル名を短くしてください"
      : "プロファイル名を短くするか、ジョブファイルの @ksql name で短い名前を指定してください";
    throw new ConfigError(
      `ジョブキー "${key}" は ${key.length} 文字で、上限 ${MAX_JOB_KEY_LENGTH} 文字を超えています` +
        `（UTF-16 コード単位）。${action}`
    );
  }
  return key;
}
