import * as fs from "fs";
import * as path from "path";

/**
 * ローカル state（設計書 6.2）。
 * ログアプリが正・state.json はオフライン時のフォールバック。
 * ログアプリへの書き込みに合わせて同期更新されるキャッシュであり、手動編集は想定しない。
 */
export interface StateFile {
  schemaVersion: 1;
  profile: string;
  batchId: string;
  /** ISO 8601 */
  asOf: string;
  timezone?: string;
  startedAt: string;
  finishedAt?: string;
  jobs: Record<string, StateJob>;
}

export interface StateJob {
  fileName: string;
  status: string;
  /** SKIPPED の理由。filtered と失敗起因の判別に使用する。 */
  skipReason?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export class StateStore {
  private readonly filePath: string;

  constructor(
    baseDir: string,
    profile: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line)
  ) {
    this.filePath = path.join(baseDir, ".ksql", `state-${profile.replace(/[^\w.-]/g, "_")}.json`);
  }

  read(): StateFile | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as StateFile;
      if (parsed.schemaVersion !== 1) {
        this.warn(`警告: state の schemaVersion ${String(parsed.schemaVersion)} は未対応です。state を使用せず続行します (${this.filePath})`);
        return null;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.warn(`警告: state が破損しているか読み取れません。state を使用せず続行します (${this.filePath})`);
      return null;
    }
  }

  write(state: StateFile): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // state はキャッシュであり、書けなくても実行は続行する
    }
  }
}
