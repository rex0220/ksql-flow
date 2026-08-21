import * as fs from "fs";
import * as path from "path";
import { SecretMasker } from "./mask";

/**
 * ローカル JSONL ログ（設計書 8.3）。
 * ログアプリの成否に関わらず全イベントを .ksql/logs/<batch_id>.jsonl に記録する。
 */
export class JsonlLogger {
  private readonly filePath: string;

  constructor(
    readonly localDir: string,
    readonly batchId: string,
    private readonly masker: SecretMasker
  ) {
    fs.mkdirSync(localDir, { recursive: true });
    this.filePath = path.join(localDir, `${batchId}.jsonl`);
  }

  append(event: string, payload: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
    try {
      fs.appendFileSync(this.filePath, this.masker.mask(line) + "\n");
    } catch {
      // ローカルログの失敗で実行自体は止めない
    }
  }
}

export interface PendingOp {
  /** insert: 新規レコード / update: recordId の更新 */
  op: "insert" | "update";
  recordId?: string;
  fields: Record<string, unknown>;
  createdAt: string;
}

/**
 * ログアプリへ書けなかった操作の再送キュー（設計書 8.3: 次回実行時に自動再送）。
 * <localDir>/pending/*.json に 1 操作 1 ファイルで保存する。
 */
export class PendingQueue {
  private readonly dir: string;
  private seq = 0;

  constructor(localDir: string, private readonly masker: SecretMasker) {
    this.dir = path.join(localDir, "pending");
  }

  enqueue(op: PendingOp): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const name = `${Date.now()}-${process.pid}-${this.seq++}.json`;
      fs.writeFileSync(path.join(this.dir, name), this.masker.mask(JSON.stringify(op)));
    } catch {
      // 再送キューへの書き込み失敗は握りつぶす（JSONL 側には記録済み）
    }
  }

  list(): Array<{ file: string; op: PendingOp }> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir).filter((entry) => entry.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const out: Array<{ file: string; op: PendingOp }> = [];
    for (const entry of entries) {
      const file = path.join(this.dir, entry);
      try {
        out.push({ file, op: JSON.parse(fs.readFileSync(file, "utf8")) as PendingOp });
      } catch {
        // 壊れたファイルはスキップ（削除はしない）
      }
    }
    return out;
  }

  remove(file: string): void {
    try {
      fs.unlinkSync(file);
    } catch {
      /* noop */
    }
  }
}
