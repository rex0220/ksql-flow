import type { FlowKintoneClient } from "@rex0220/kintone-sql-tools/flow";
import { LockedError, LockUnavailableError, errorMessage, findHttpStatus } from "./errors";
import { JsonlLogger, PendingQueue } from "./logging/jsonl";
import { JobStatus } from "./types";

/** ログアプリのフィールド定義（設計書 8.2）。init-logapp / --check-logapp が使う正の定義 */
export const LOG_APP_FIELDS: Record<string, { type: string; label: string; unique?: boolean; options?: string[] }> = {
  record_type: { type: "DROP_DOWN", label: "レコード種別", options: ["BATCH", "JOB"] },
  status: {
    type: "DROP_DOWN",
    label: "ステータス",
    options: ["SUCCESS", "NO_DATA", "FAILED", "ABORTED", "SKIPPED", "RUNNING", "TIMEOUT", "CANCELLED"],
  },
  batch_id: { type: "SINGLE_LINE_TEXT", label: "バッチ実行ID" },
  correlation_id: { type: "SINGLE_LINE_TEXT", label: "相関ID" },
  attempt_id: { type: "SINGLE_LINE_TEXT", label: "試行ID" },
  execution_id: { type: "SINGLE_LINE_TEXT", label: "実行ID" },
  job_id: { type: "SINGLE_LINE_TEXT", label: "論理ジョブ名" },
  runner_execution_started_at: { type: "DATETIME", label: "SQL実行開始日時" },
  parent_batch_id: { type: "SINGLE_LINE_TEXT", label: "親バッチID" },
  job_key: { type: "SINGLE_LINE_TEXT", label: "ジョブキー", unique: true },
  job_key_done: { type: "SINGLE_LINE_TEXT", label: "ジョブキー履歴" },
  script_name: { type: "SINGLE_LINE_TEXT", label: "スクリプト名" },
  profile: { type: "SINGLE_LINE_TEXT", label: "プロファイル" },
  as_of: { type: "DATETIME", label: "実行基準時刻" },
  started_at: { type: "DATETIME", label: "開始日時" },
  finished_at: { type: "DATETIME", label: "終了日時" },
  duration_sec: { type: "NUMBER", label: "所要時間(秒)" },
  read_count: { type: "NUMBER", label: "取得件数" },
  written_count: { type: "NUMBER", label: "書込件数" },
  deleted_count: { type: "NUMBER", label: "削除件数" },
  last_written_key: { type: "SINGLE_LINE_TEXT", label: "最終書込キー" },
  api_calls: { type: "NUMBER", label: "API消費回数" },
  executed_by: { type: "SINGLE_LINE_TEXT", label: "実行者" },
  host: { type: "SINGLE_LINE_TEXT", label: "実行ホスト" },
  git_ref: { type: "SINGLE_LINE_TEXT", label: "Git リビジョン" },
  ksql_version: { type: "SINGLE_LINE_TEXT", label: "エンジン版数" },
  error_message: { type: "MULTI_LINE_TEXT", label: "エラー内容" },
  log_detail: { type: "MULTI_LINE_TEXT", label: "実行詳細ログ" },
};

const LOG_FIELD_CODES = Object.keys(LOG_APP_FIELDS);
export const OPTIONAL_LOG_APP_FIELD_CODES: ReadonlySet<string> = new Set(["deleted_count"]);
export const ORCHESTRATOR_LOG_APP_FIELD_CODES: readonly string[] = [
  "correlation_id",
  "attempt_id",
  "execution_id",
  "job_id",
  "runner_execution_started_at",
];

/** kintone 複数行文字列の実効上限（8.3: 約 65,535 字。安全側に切り詰める） */
const DETAIL_HEAD = 40000;
const DETAIL_TAIL = 15000;

export function truncateDetail(text: string): string {
  if (text.length <= DETAIL_HEAD + DETAIL_TAIL + 100) return text;
  const omitted = text.length - DETAIL_HEAD - DETAIL_TAIL;
  return (
    text.slice(0, DETAIL_HEAD) +
    `\n...[中略 ${omitted} 文字。全文はローカル JSONL ログを参照]...\n` +
    text.slice(text.length - DETAIL_TAIL)
  );
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface LogRecordFields {
  [code: string]: string | number | undefined;
}

function toKintoneRecord(fields: LogRecordFields): Record<string, { value: string }> {
  const record: Record<string, { value: string }> = {};
  for (const [code, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    record[code] = { value: String(value) };
  }
  return record;
}

export interface RunningRecord {
  id: string;
  revision: number;
  status: string;
  startedAt: string | null;
  batchId: string;
  jobKey: string;
  host: string;
  scriptName: string;
}

/**
 * ログアプリへの読み書き（設計書 8 章）+ job_key 分散ロック（5.5）。
 * すべてランナー共通の HTTP 層（単一 API カウンタ）経由で行う。
 */
export class LogAppClient {
  private fieldSupport: Promise<{ codes: ReadonlySet<string>; error?: unknown }> | null = null;

  constructor(
    private readonly client: FlowKintoneClient,
    readonly appId: number,
    private readonly jsonl: JsonlLogger,
    private readonly pending: PendingQueue,
    private readonly out: (line: string) => void = () => undefined
  ) {}

  /** getFields の結果をプロセス内で一度だけ取得し、並行書込と厳格検査で共用する。 */
  private fieldSupportResult(): Promise<{ codes: ReadonlySet<string>; error?: unknown }> {
    if (this.fieldSupport === null) {
      this.fieldSupport = this.client
        .getFields(this.appId)
        .then((definitions) => {
          const codes = new Set(definitions.map((field) => field.code));
          if (!codes.has("deleted_count")) {
            this.out("  情報: ログアプリに deleted_count がありません（テンプレート v0.3 で追加。任意）");
          }
          return { codes };
        })
        .catch((error) => {
          this.out(
            `  情報: ログアプリのフィールド判定に失敗したため任意フィールド（deleted_count・相関フィールド）は送信しません (${errorMessage(error)})`
          );
          // standalone は従来フィールドで書込を続行する。orchestrator は error を見て fail-closed にする。
          const legacyCodes = new Set(LOG_FIELD_CODES.filter(
            (code) => !OPTIONAL_LOG_APP_FIELD_CODES.has(code) && !ORCHESTRATOR_LOG_APP_FIELD_CODES.includes(code)
          ));
          return { codes: legacyCodes, error };
        });
    }
    return this.fieldSupport;
  }

  /** orchestrator の耐久証跡に必要なフィールドを、ロック取得前に厳格検査する。 */
  async requireFields(requiredCodes: readonly string[]): Promise<void> {
    const support = await this.fieldSupportResult();
    if (support.error !== undefined) {
      throw new LockUnavailableError(
        `ログアプリのフィールドを確認できないため orchestrator 実行を開始できません (fail-closed): ${errorMessage(support.error)}`,
        support.error
      );
    }
    const missing = requiredCodes.filter((code) => !support.codes.has(code));
    if (missing.length > 0) {
      throw new LockUnavailableError(
        `ログアプリに orchestrator 必須フィールドがありません (fail-closed): ${missing.join(", ")}`
      );
    }
  }

  /** 旧 schema 互換のため、実在するフィールドだけを送る。 */
  private async writableFields(fields: LogRecordFields): Promise<LogRecordFields> {
    const { codes } = await this.fieldSupportResult();
    const compatible: LogRecordFields = {};
    for (const [code, value] of Object.entries(fields)) {
      if (codes.has(code)) compatible[code] = value;
    }
    return compatible;
  }

  /** job_key を持つ RUNNING レコードを探す（ロック競合・stale 判定用） */
  async findByJobKey(jobKey: string): Promise<RunningRecord | null> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `job_key = "${escapeQueryValue(jobKey)}" limit 1`,
      fields: ["$id", "$revision", "status", "started_at", "batch_id", "job_key", "host", "script_name"],
    });
    const record = result.records[0];
    if (record === undefined) return null;
    return {
      id: String(record["$id"]?.value ?? ""),
      revision: Number(record["$revision"]?.value ?? 0),
      status: String(record["status"]?.value ?? ""),
      startedAt: record["started_at"]?.value ? String(record["started_at"].value) : null,
      batchId: String(record["batch_id"]?.value ?? ""),
      jobKey,
      host: String(record["host"]?.value ?? ""),
      scriptName: String(record["script_name"]?.value ?? ""),
    };
  }

  /**
   * RUNNING レコードの先行 INSERT による分散ロック取得。
   * - 事前 GET で既存 RUNNING を検知（stale なら回収してから続行）
   * - INSERT の 400 は再 GET し、job_key の存在が確認できた場合だけ LockedError
   * - その他の失敗は fail-closed（LockUnavailableError。設計書 5.5-4）
   */
  async acquireLock(params: {
    jobKey: string;
    fields: LogRecordFields;
    staleBeforeMs: number | null;
    onStaleRecovered?: (record: RunningRecord) => void;
  }): Promise<string> {
    let existing: RunningRecord | null;
    try {
      existing = await this.findByJobKey(params.jobKey);
    } catch (error) {
      throw new LockUnavailableError(
        `ログアプリに到達できないため分散ロックを確立できません (fail-closed): ${errorMessage(error)}`,
        error
      );
    }
    if (existing !== null) {
      const startedAt = existing.startedAt !== null ? Date.parse(existing.startedAt) : NaN;
      const isStale =
        params.staleBeforeMs !== null &&
        Number.isFinite(startedAt) &&
        startedAt < params.staleBeforeMs;
      if (!isStale) {
        throw new LockedError(
          `ジョブキー "${params.jobKey}" は実行中です（多重起動検知。ハングの場合は ksql-flow unlock で解除）`
        );
      }
      await this.recoverStale(existing, "stale ロックを自動回収しました（started_at が batchTimeoutSec を超過）");
      params.onStaleRecovered?.(existing);
    }
    try {
      const fields = await this.writableFields({ ...params.fields, job_key: params.jobKey, status: "RUNNING" });
      const result = await this.client.postRecords({
        app: this.appId,
        records: [toKintoneRecord(fields)],
      });
      return result.ids[0];
    } catch (error) {
      const status = findHttpStatus(error);
      if (status === 400) {
        try {
          const raced = await this.findByJobKey(params.jobKey);
          if (raced !== null) {
            throw new LockedError(
              `ジョブキー "${params.jobKey}" は実行中です（RUNNING レコードの競合を確認）`
            );
          }
        } catch (confirmError) {
          if (confirmError instanceof LockedError) throw confirmError;
          throw new LockUnavailableError(
            `ログアプリの RUNNING レコード挿入失敗後にロック状態を確認できません (fail-closed): ${errorMessage(confirmError)}`,
            confirmError
          );
        }
      }
      throw new LockUnavailableError(
        `ログアプリへ RUNNING レコードを挿入できません (fail-closed): ${errorMessage(error)}`,
        error
      );
    }
  }

  /** stale な RUNNING レコードを TIMEOUT へ回収する（設計書 5.5: 回収の事実を log_detail に記録） */
  async recoverStale(record: RunningRecord, note: string): Promise<void> {
    await this.update(record.id, {
      status: "TIMEOUT",
      job_key: "",
      job_key_done: record.jobKey,
      finished_at: toKintoneDateTime(new Date()),
      log_detail: note,
    });
    this.jsonl.append("stale_lock_recovered", { recordId: record.id, jobKey: record.jobKey });
  }

  /**
   * orchestrator 用の対象限定明示解除。
   *
   * 検索時の identity を record-id GET で再確認し、その revision を PUT に指定する。
   * PUT 応答が失われた場合は job_key を再照会し、クリア済みと確認できた場合だけ
   * RELEASED とする。既存 recoverStale / unlock の挙動には影響させない。
   */
  async forceUnlockJob(params: {
    observed: RunningRecord;
    reason: string;
    confirmedBy: string;
    evidenceRef: string;
    profileName: string;
    executedAt: Date;
  }): Promise<"RELEASED" | "NOT_FOUND" | "NOT_RUNNING" | "CONFLICT" | "UNCONFIRMED"> {
    const current = await this.findByRecordId(params.observed.id);
    if (current === null) {
      const replacement = await this.findByJobKey(params.observed.jobKey);
      return replacement === null ? "NOT_FOUND" : "CONFLICT";
    }
    if (
      current.id !== params.observed.id ||
      current.batchId !== params.observed.batchId ||
      current.jobKey !== params.observed.jobKey
    ) {
      return "CONFLICT";
    }
    if (current.status !== "RUNNING") return "NOT_RUNNING";

    const audit = {
      operation: "force-unlock-job",
      jobKey: params.observed.jobKey,
      reason: params.reason,
      confirmedBy: params.confirmedBy,
      evidenceRef: params.evidenceRef,
      authenticationSubject: `profile:${params.profileName}`,
      executedAt: toKintoneDateTime(params.executedAt),
    };
    const auditDetail = truncateDetail(`LOCK_RECOVERY ${JSON.stringify(audit)}`);
    const fields = await this.writableFields({
      status: "FAILED",
      job_key: "",
      job_key_done: params.observed.jobKey,
      finished_at: toKintoneDateTime(params.executedAt),
      log_detail: auditDetail,
    });

    try {
      await this.client.putRecords({
        app: this.appId,
        records: [{
          id: Number(current.id),
          revision: current.revision,
          record: toKintoneRecord(fields),
        }],
      });
      this.jsonl.append("job_lock_force_released", {
        recordId: current.id,
        jobKey: current.jobKey,
        confirmedBy: params.confirmedBy,
        evidenceRef: params.evidenceRef,
      });
      return "RELEASED";
    } catch (updateError) {
      try {
        const after = await this.findByJobKey(params.observed.jobKey);
        if (after === null) {
          // PUT 適用後の応答喪失と、409 競合で他者が先に解放した場合を、
          // 同一 record ID に残った監査内容で区別する。
          if (!(await this.hasForceUnlockAudit(current.id, current.jobKey, auditDetail))) {
            return "NOT_RUNNING";
          }
          this.jsonl.append("job_lock_force_released", {
            recordId: current.id,
            jobKey: current.jobKey,
            confirmation: "post-update-get",
          });
          return "RELEASED";
        }
        if (
          findHttpStatus(updateError) === 409 &&
          after.id === current.id &&
          after.batchId === current.batchId
        ) return "CONFLICT";
        return "UNCONFIRMED";
      } catch {
        return "UNCONFIRMED";
      }
    }
  }

  private async hasForceUnlockAudit(recordId: string, jobKey: string, auditDetail: string): Promise<boolean> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `$id = ${Number(recordId)} limit 1`,
      fields: ["$id", "job_key", "job_key_done", "log_detail"],
    });
    const record = result.records[0];
    return record !== undefined &&
      String(record["job_key"]?.value ?? "") === "" &&
      String(record["job_key_done"]?.value ?? "") === jobKey &&
      String(record["log_detail"]?.value ?? "") === auditDetail;
  }

  private async findByRecordId(recordId: string): Promise<RunningRecord | null> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `$id = ${Number(recordId)} limit 1`,
      fields: ["$id", "$revision", "status", "started_at", "batch_id", "job_key", "host", "script_name"],
    });
    const record = result.records[0];
    if (record === undefined) return null;
    return {
      id: String(record["$id"]?.value ?? ""),
      revision: Number(record["$revision"]?.value ?? 0),
      status: String(record["status"]?.value ?? ""),
      startedAt: record["started_at"]?.value ? String(record["started_at"].value) : null,
      batchId: String(record["batch_id"]?.value ?? ""),
      jobKey: String(record["job_key"]?.value ?? ""),
      host: String(record["host"]?.value ?? ""),
      scriptName: String(record["script_name"]?.value ?? ""),
    };
  }

  /**
   * 実行中レコードの終了更新（job_key クリア + job_key_done 退避。設計書 5.5）。
   * 失敗時はローカル JSONL + 再送キューへ退避し、呼び出し元へは失敗を伝えない（8.3）。
   */
  async finishRecord(
    recordId: string,
    jobKey: string,
    status: JobStatus | "CANCELLED",
    fields: LogRecordFields
  ): Promise<boolean> {
    const payload: LogRecordFields = {
      ...fields,
      status,
      job_key: "",
      job_key_done: jobKey,
    };
    try {
      await this.update(recordId, payload);
      return true;
    } catch (error) {
      this.jsonl.append("logapp_write_failed", {
        recordId,
        status,
        error: errorMessage(error),
      });
      this.pending.enqueue({ op: "update", recordId, fields: payload, createdAt: new Date().toISOString() });
      return false;
    }
  }

  /** チェックポイント等の途中更新（失敗しても止めない・再送キューにも積まない） */
  async updateCheckpoint(recordId: string, fields: LogRecordFields): Promise<void> {
    try {
      await this.update(recordId, fields);
    } catch (error) {
      this.jsonl.append("checkpoint_write_failed", { recordId, error: errorMessage(error) });
    }
  }

  /**
   * orchestrator の SQL 開始証跡を耐久化する。
   *
   * acquireLock の INSERT 直後にだけ呼ぶため expected revision は 1。公式 Flow API が
   * revision を kintone PUT へ透過するので、別更新が先行した場合は楽観ロックで拒否する。
   * PUT 応答を確認できない場合だけ同一 record ID を GET し、自分の値が残っていれば成功とみなす。
   * checkpoint と異なり、確認不能を握りつぶしたり再送キューへ積んだりしない。
   */
  async markExecutionStarted(recordId: string, startedAt: Date): Promise<void> {
    const value = toKintoneDateTime(startedAt);
    try {
      const compatible = await this.writableFields({ runner_execution_started_at: value });
      if (!("runner_execution_started_at" in compatible)) throw new Error("runner_execution_started_at is not writable");
      await this.client.putRecords({
        app: this.appId,
        records: [{
          id: Number(recordId),
          revision: 1,
          record: toKintoneRecord(compatible),
        }],
      });
      return;
    } catch (updateError) {
      try {
        const result = await this.client.getRecords({
          app: this.appId,
          query: `$id = ${Number(recordId)} limit 1`,
          fields: ["$id", "runner_execution_started_at"],
        });
        const persisted = String(result.records[0]?.["runner_execution_started_at"]?.value ?? "");
        // kintone DATETIME は分精度で保存される。この対象レコードの
        // runner_execution_started_at は自分だけが書くため、双方を分単位へ
        // 正規化した一致で今回の UPDATE の永続化確認として十分である。
        const expectedMinute = toDateTimeMinute(value);
        if (expectedMinute !== null && toDateTimeMinute(persisted) === expectedMinute) return;
        throw new Error("runner_execution_started_at が書込値と一致しません");
      } catch (confirmError) {
        throw new LockUnavailableError(
          `EXECUTION_STARTED をログアプリで確認できないため SQL を開始しません (fail-closed): ${errorMessage(confirmError)}`,
          updateError
        );
      }
    }
  }

  async update(recordId: string, fields: LogRecordFields): Promise<void> {
    const compatible = await this.writableFields(fields);
    await this.client.putRecords({
      app: this.appId,
      records: [{ id: Number(recordId), record: toKintoneRecord(compatible) }],
    });
  }

  /** ロックを伴わない INSERT（SKIPPED 記録等）。失敗時は再送キューへ */
  async insertRecord(fields: LogRecordFields): Promise<string | null> {
    try {
      const compatible = await this.writableFields(fields);
      const result = await this.client.postRecords({
        app: this.appId,
        records: [toKintoneRecord(compatible)],
      });
      return result.ids[0];
    } catch (error) {
      this.jsonl.append("logapp_write_failed", { error: errorMessage(error) });
      this.pending.enqueue({ op: "insert", fields, createdAt: new Date().toISOString() });
      return null;
    }
  }

  /** 未送信分の再送（設計書 8.3: 次回実行時に自動再送）。失敗した分はキューに残す */
  async resendPending(): Promise<number> {
    let sent = 0;
    for (const { file, op } of this.pending.list()) {
      try {
        if (op.op === "insert") {
          const compatible = await this.writableFields(op.fields as LogRecordFields);
          await this.client.postRecords({ app: this.appId, records: [toKintoneRecord(compatible)] });
        } else if (op.recordId !== undefined) {
          await this.update(op.recordId, op.fields as LogRecordFields);
        }
        this.pending.remove(file);
        sent += 1;
      } catch (error) {
        this.jsonl.append("resend_failed", { file, error: errorMessage(error) });
        break; // 到達不能とみなし残りは次回へ
      }
    }
    if (sent > 0) this.jsonl.append("resend_done", { count: sent });
    return sent;
  }

  /** 直近バッチの状態取得（--resume 用。設計書 6.2: ログアプリが正） */
  async findLatestBatch(profile: string): Promise<{ batchId: string; asOf: string | null } | null> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `record_type in ("BATCH") and profile = "${escapeQueryValue(profile)}" order by started_at desc limit 1`,
      fields: ["batch_id", "as_of", "status"],
    });
    const record = result.records[0];
    if (record === undefined) return null;
    return {
      batchId: String(record["batch_id"]?.value ?? ""),
      asOf: record["as_of"]?.value ? String(record["as_of"].value) : null,
    };
  }

  /** batch_id が一致する BATCH を列挙（--resume-batch の一意性・profile 検査用） */
  async findBatchesById(batchId: string): Promise<Array<{ batchId: string; profile: string; asOf: string | null }>> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `record_type in ("BATCH") and batch_id = "${escapeQueryValue(batchId)}" limit 2`,
      fields: ["batch_id", "profile", "as_of"],
    });
    return result.records.map((record) => ({
      batchId: String(record["batch_id"]?.value ?? ""),
      profile: String(record["profile"]?.value ?? ""),
      asOf: record["as_of"]?.value ? String(record["as_of"].value) : null,
    }));
  }

  /** 指定バッチ配下の JOB レコードの最終状態を取得（--resume 用） */
  async listBatchJobs(parentBatchId: string): Promise<Array<{ scriptName: string; status: string; logDetail: string }>> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `record_type in ("JOB") and parent_batch_id = "${escapeQueryValue(parentBatchId)}" limit 500`,
      fields: ["script_name", "status", "log_detail"],
    });
    return result.records.map((record) => ({
      scriptName: String(record["script_name"]?.value ?? ""),
      status: String(record["status"]?.value ?? ""),
      logDetail: String(record["log_detail"]?.value ?? ""),
    }));
  }

  /** プロファイル配下の RUNNING レコードを列挙（unlock 用） */
  async listRunning(profile: string): Promise<RunningRecord[]> {
    const result = await this.client.getRecords({
      app: this.appId,
      query: `status in ("RUNNING") and profile = "${escapeQueryValue(profile)}" limit 500`,
      fields: ["$id", "$revision", "status", "started_at", "batch_id", "job_key", "host", "script_name"],
    });
    return result.records.map((record) => ({
      id: String(record["$id"]?.value ?? ""),
      revision: Number(record["$revision"]?.value ?? 0),
      status: "RUNNING",
      startedAt: record["started_at"]?.value ? String(record["started_at"].value) : null,
      batchId: String(record["batch_id"]?.value ?? ""),
      jobKey: String(record["job_key"]?.value ?? ""),
      host: String(record["host"]?.value ?? ""),
      scriptName: String(record["script_name"]?.value ?? ""),
    }));
  }
}

export function expectedLogFieldCodes(): string[] {
  return [...LOG_FIELD_CODES];
}

/** kintone DATETIME 形式（ISO 8601 UTC） */
export function toKintoneDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function toDateTimeMinute(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 60_000) : null;
}
