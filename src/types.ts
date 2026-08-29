/** ジョブ / バッチの終了ステータス（設計書 3.2 / 8.2）。LOCKED はログアプリには保存しないプロセス内ステータス。 */
export type JobStatus =
  | "SUCCESS"
  | "NO_DATA"
  | "FAILED"
  | "ABORTED"
  | "SKIPPED"
  | "RUNNING"
  | "TIMEOUT"
  | "LOCKED";

/** Exit Codes（設計書 10.3） */
export const EXIT = {
  OK: 0,
  VALIDATION: 1,
  ABORTED: 2,
  RUNTIME: 3,
  PARTIAL: 4,
  LOCKED: 5,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 1 ジョブの実行結果（オーケストレータ / ログ / 通知が参照する共通形） */
export interface JobOutcome {
  jobName: string;
  scriptName: string;
  status: JobStatus;
  exitCode: ExitCode;
  /** SKIPPED の理由（"dependency: xxx" / "LOCKED" / "stop-on-error" 等） */
  skipReason?: string;
  errorMessage?: string;
  startedAt?: Date;
  finishedAt?: Date;
  readCount: number;
  writtenCount: number;
  /** DELETE で削除した件数（writtenCount の内数） */
  deletedCount: number;
  apiCalls: number;
  lastWrittenKey?: string;
  /** 実書込が完了した 100 件チャンク数（Execution Result の診断値） */
  writeChunks?: number;
  /** ASSERT WARNING 等、log_detail へ残す行 */
  detailLines: string[];
}

export interface BatchOutcome {
  batchId: string;
  profile: string;
  asOf: Date;
  status: JobStatus;
  exitCode: ExitCode;
  jobs: JobOutcome[];
  startedAt: Date;
  finishedAt?: Date;
  apiCalls: number;
}
