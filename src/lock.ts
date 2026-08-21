import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LockedError } from "./errors";

interface LocalLockContent {
  pid: number;
  host: string;
  profile: string;
  startedAt: string;
  batchId: string;
}

/**
 * ローカルロック（設計書 5.5-1）。
 * .ksql/lock-<profile>.json を O_EXCL で作成する。stale 判定は
 * (a) 同一ホストのプロセス生存確認、(b) startedAt + batchTimeoutSec 超過。
 */
export class LocalLock {
  private readonly filePath: string;
  private heldBatchId: string | null = null;

  constructor(baseDir: string, private readonly profile: string) {
    this.filePath = path.join(baseDir, ".ksql", `lock-${sanitize(profile)}.json`);
  }

  acquire(batchId: string, batchTimeoutSec: number | null): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const content: LocalLockContent = {
      pid: process.pid,
      host: os.hostname(),
      profile: this.profile,
      startedAt: new Date().toISOString(),
      batchId,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.filePath, "wx");
        fs.writeFileSync(fd, JSON.stringify(content));
        fs.closeSync(fd);
        this.heldBatchId = batchId;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = this.read();
        if (existing !== null && !this.isStale(existing, batchTimeoutSec)) {
          throw new LockedError(
            `ローカルロックが存在します: ${this.filePath} (pid=${existing.pid}, host=${existing.host}, ` +
            `開始=${existing.startedAt})。前回実行が完了していないか、ハング中の可能性があります` +
            `（ksql-flow unlock または --force-unlock で解除）`
          );
        }
        // stale → 回収して再試行
        try {
          fs.unlinkSync(this.filePath);
        } catch {
          /* 競合で消えた場合はそのまま再試行 */
        }
      }
    }
    throw new LockedError(`ローカルロックを取得できません: ${this.filePath}`);
  }

  release(): void {
    const batchId = this.heldBatchId;
    if (batchId === null) return;
    this.heldBatchId = null;
    try {
      const existing = this.read();
      if (existing === null || existing.batchId !== batchId) return;
      fs.unlinkSync(this.filePath);
    } catch {
      /* noop */
    }
  }

  /** unlock コマンド用の明示解除 */
  forceRelease(): boolean {
    try {
      fs.unlinkSync(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  read(): LocalLockContent | null {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as LocalLockContent;
    } catch {
      return null;
    }
  }

  private isStale(content: LocalLockContent, batchTimeoutSec: number | null): boolean {
    // プロセス生存確認は同一ホスト内のみ有効（設計書 5.5-1）
    if (content.host === os.hostname()) {
      try {
        process.kill(content.pid, 0);
        return false; // 同一ホストで PID が生存中なら経過時間だけでは回収しない
      } catch {
        return true; // プロセスが存在しない
      }
    }
    if (batchTimeoutSec !== null) {
      const startedAt = Date.parse(content.startedAt);
      if (Number.isFinite(startedAt) && Date.now() - startedAt > batchTimeoutSec * 1000) return true;
    }
    return false;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}
