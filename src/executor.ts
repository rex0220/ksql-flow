import { execSync } from "child_process";
import * as os from "os";
import * as path from "path";
import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  isDmlResult,
  version as engineVersion,
  type ExecutionContext,
  type FlowChunkWrittenInfo,
  type FlowDmlResult,
  type FlowKintoneClient,
  type StatementResult,
} from "@rex0220/kintone-sql-tools/flow";
import { ResolvedProfile } from "./config";
import { classifyRuntimeError, errorMessage, LockedError, LockUnavailableError } from "./errors";
import { HttpLayer } from "./http";
import { JobFile, MAX_STATEMENTS } from "./jobs";
import { LogAppClient, LogRecordFields, toKintoneDateTime, truncateDetail } from "./logapp";
import { JsonlLogger } from "./logging/jsonl";
import { maskFieldValue, SecretMasker, stripSqlLiterals } from "./logging/mask";
import { EXIT, JobOutcome, JobStatus } from "./types";

/** チェックポイント更新の間隔（書込チャンク数）。設計書 5.1-2 の「定期的に」の実装値 */
const CHECKPOINT_EVERY_CHUNKS = 25;
const CHECKPOINT_EVERY_MS = 60_000;

export interface RunnerEnv {
  profile: ResolvedProfile;
  http: HttpLayer;
  client: FlowKintoneClient;
  logApp: LogAppClient | null;
  jsonl: JsonlLogger;
  masker: SecretMasker;
  out: (line: string) => void;
  /** ログアプリ表示用ホスト。ローカルロックの生存判定には使用しない。 */
  logHost: string;
  /** --lock local-only（設計書 5.5-4 の明示緩和） */
  lockLocalOnly: boolean;
}

export interface RunJobParams {
  job: JobFile;
  asOf: Date;
  batchId: string;
  parentBatchId?: string;
  /** ジョブ timeout とバッチ残り時間の小さい方（ms）。null なら無制限 */
  timeoutMs: number | null;
  jobKey: string;
  /** 最初の executeStatement の直前。M1-d の耐久 EXECUTION_STARTED もこの挿入点を使う。 */
  onExecutionStart?: (startedAt: Date) => void | Promise<void>;
  /** orchestrator のみ。最初の SQL 文より先にログアプリへ EXECUTION_STARTED を耐久化する。 */
  durableExecutionStarted?: boolean;
  /** Execution Result 境界へ分類材料を渡す観測フック。既存の結果・ログには影響させない。 */
  onExecutionError?: (cause: unknown, code?: string) => void;
  /** orchestrator 実行の JOB レコードにだけ保存する相関値。 */
  correlation?: { correlationId: string; attemptId: string };
}

// package.json の version を正とする（ハードコードだと npm version 更新に追随できず、
// v0.2.0 リリース後もログアプリに「flow 0.1.0」が記録される表示漏れが実機検証で発覚した）
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const RUNNER_VERSION: string = (require("../package.json") as { version: string }).version;

type ExecutionMetrics = StatementResult["metrics"];

const gitRefCache = new Map<string, string>();

/** 実行時の Git リビジョン（設計書 8.2 git_ref。取得できなければ空） */
export function resolveGitRef(dir: string): string {
  const cached = gitRefCache.get(dir);
  if (cached !== undefined) return cached;
  let ref = "";
  try {
    ref = execSync("git rev-parse HEAD", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    ref = "";
  }
  gitRefCache.set(dir, ref);
  return ref;
}

/**
 * 1 ジョブを実行する（タスク指示書 C / 設計書 3・5 章）。
 * 分散ロック（RUNNING レコード先行 INSERT）→ 文ループ → ステータス集約 → 終了更新。
 * LockedError / LockUnavailableError はここでは捕捉せず呼び出し元で Exit 5 / 3 に変換する。
 */
export async function runJob(env: RunnerEnv, params: RunJobParams): Promise<JobOutcome> {
  const { job, asOf } = params;
  const startedAt = new Date();
  const apiCallsBefore = env.http.snapshot();
  const detailLines: string[] = [];
  const outcomeBase = {
    jobName: job.name,
    scriptName: job.fileName,
    startedAt,
    detailLines,
  };

  // parse エラーは実行前に FAILED (Exit 1)
  const parseErrors = job.parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (parseErrors.length > 0 || job.parsed.statements.length > MAX_STATEMENTS) {
    const message =
      parseErrors.length > 0
        ? parseErrors.map((d) => `${d.code} ${d.message} (${d.line}:${d.column})`).join("\n")
        : `1 スクリプトの文数上限 (${MAX_STATEMENTS} 文) を超えています (${job.parsed.statements.length} 文)`;
    env.out(`  検証エラー: ${message}`);
    return {
      ...outcomeBase,
      status: "FAILED",
      exitCode: EXIT.VALIDATION,
      errorMessage: message,
      finishedAt: new Date(),
      readCount: 0,
      writtenCount: 0,
      deletedCount: 0,
      apiCalls: 0,
    };
  }

  const baseFields: LogRecordFields = {
    record_type: "JOB",
    batch_id: params.batchId,
    parent_batch_id: params.parentBatchId ?? "",
    script_name: job.fileName,
    profile: env.profile.name,
    as_of: toKintoneDateTime(asOf),
    started_at: toKintoneDateTime(startedAt),
    executed_by: safeUser(),
    host: env.logHost,
    git_ref: resolveGitRef(path.dirname(job.filePath)),
    ksql_version: `flow ${RUNNER_VERSION} / engine ${engineVersion}`,
    ...(params.correlation !== undefined ? {
      correlation_id: params.correlation.correlationId,
      attempt_id: params.correlation.attemptId,
      execution_id: params.batchId,
      job_id: job.name,
    } : {}),
  };

  // 分散ロック（設計書 5.5-2/4）
  let recordId: string | null = null;
  if (env.logApp !== null) {
    const batchTimeoutSec = env.profile.limits.batchTimeoutSec;
    try {
      recordId = await env.logApp.acquireLock({
        jobKey: params.jobKey,
        fields: baseFields,
        staleBeforeMs: batchTimeoutSec !== null ? Date.now() - batchTimeoutSec * 1000 : null,
        onStaleRecovered: () => env.out(`  警告: stale ロックを自動回収しました (${params.jobKey})`),
      });
    } catch (error) {
      if (error instanceof LockedError) throw error;
      if (error instanceof LockUnavailableError && env.lockLocalOnly) {
        env.out(`  警告: ログアプリに到達できません。--lock local-only 指定によりローカルロックのみで続行します`);
        env.jsonl.append("lock_local_only", { jobKey: params.jobKey, error: errorMessage(error) });
      } else {
        throw error;
      }
    }
  }

  env.jsonl.append("job_start", {
    job: job.name,
    file: job.fileName,
    batchId: params.batchId,
    parentBatchId: params.parentBatchId ?? null,
    asOf: asOf.toISOString(),
    jobKey: params.jobKey,
  });

  // チェックポイント（v3.70.0 onChunkWritten。キー値は順序保証のない診断情報）
  let writeChunks = 0;
  let chunkRows = 0;
  let deletedChunkRows = 0;
  let lastWrittenKey: string | undefined;
  let lastCheckpointChunks = 0;
  let lastCheckpointAt = Date.now();
  const onChunkWritten = async (info: FlowChunkWrittenInfo): Promise<void> => {
    if (env.logApp !== null && info.appId === env.logApp.appId) return; // ログアプリ自身の書込は対象外
    writeChunks += 1;
    chunkRows += info.records;
    if (info.operation === "DELETE") deletedChunkRows += info.records;
    const diagnosticKey = maskLastKeyValue(env, job, info);
    if (diagnosticKey !== undefined) lastWrittenKey = diagnosticKey;
    env.jsonl.append("write_chunk", {
      job: job.name,
      statementIndex: info.statementIndex,
      app: info.appId,
      operation: info.operation,
      records: info.records,
      chunk: writeChunks,
      statementChunk: info.chunkIndex,
      lastKeyValue: diagnosticKey ?? null,
    });
    const due =
      writeChunks - lastCheckpointChunks >= CHECKPOINT_EVERY_CHUNKS ||
      Date.now() - lastCheckpointAt >= CHECKPOINT_EVERY_MS;
    if (due && recordId !== null && env.logApp !== null) {
      lastCheckpointChunks = writeChunks;
      lastCheckpointAt = Date.now();
      const logApp = env.logApp;
      const id = recordId;
      const fields: LogRecordFields = {
        written_count: chunkRows,
        deleted_count: deletedChunkRows,
        last_written_key: lastWrittenKey ?? `chunk:${writeChunks}`,
        api_calls: env.http.snapshot() - apiCallsBefore,
      };
      // エンジンは callback を await する。ログアプリ I/O は間引き時だけ待つ。
      await logApp.updateCheckpoint(id, fields);
    }
  };

  let status: JobStatus = "SUCCESS";
  let exitCode: number = EXIT.OK;
  let errorText: string | undefined;
  let readCount = 0;
  let writtenCount = 0;
  let deletedCount = 0;
  let context: ExecutionContext | null = null;
  try {
    context = createExecutionContext({
      client: env.client,
      statements: job.parsed.statements,
      meta: job.parsed.meta,
      asOf,
      ...(env.profile.timezone !== undefined ? { timezone: env.profile.timezone } : {}),
      ...(params.timeoutMs !== null ? { timeoutMs: params.timeoutMs } : {}),
      ...(env.profile.limits.maxReadRows !== null ? { maxRecords: env.profile.limits.maxReadRows } : {}),
      ...(env.profile.limits.maxTempRows !== null ? { tempTableMaxRows: env.profile.limits.maxTempRows } : {}),
      onChunkWritten,
    });

    let sawNoData = false;
    let sawTimeout = false;
    let failure: { message: string; exitCode: number } | null = null;
    let abortMessage: string | null = null;
    let previousMetrics: ExecutionMetrics | null = null;
    let executionStartNotified = false;
    for (const [index, statement] of job.parsed.statements.entries()) {
      if (!executionStartNotified) {
        executionStartNotified = true;
        // kintone DATETIME はミリ秒を保持しない。結果 JSON と耐久値を同一時点にするため、
        // フックへ渡す Date 自体を kintone の保存精度へ正規化する。
        const executionStartedAt = new Date(toKintoneDateTime(new Date()));
        if (params.durableExecutionStarted === true) {
          if (env.logApp === null || recordId === null) {
            throw new LockUnavailableError(
              "EXECUTION_STARTED を耐久化する JOB レコードがないため SQL を開始しません (fail-closed)"
            );
          }
          await env.logApp.markExecutionStarted(recordId, executionStartedAt);
          env.jsonl.append("execution_started", {
            job: job.name,
            recordId,
            startedAt: executionStartedAt.toISOString(),
          });
        }
        if (params.onExecutionStart !== undefined) {
          await params.onExecutionStart(executionStartedAt);
        }
      }
      const result = await executeStatement(statement, context);
      const statementMetrics = metricsDelta(result.metrics, previousMetrics);
      const statementWrittenCount = writtenRows(result);
      const statementDeletedCount = deletedRows(result);
      previousMetrics = result.metrics;
      readCount += statementMetrics.fetchedRows;
      recordStatementDetail(env, job, index, result, detailLines);
      env.jsonl.append("statement", {
        job: job.name,
        index,
        type: result.type,
        status: result.status,
        kind: result.kind,
        rowCount: result.rowCount ?? null,
        skippedReason: result.skippedReason ?? null,
        readCount: statementMetrics.fetchedRows,
        writtenCount: statementWrittenCount,
        apiCalls: statementMetrics.apiCalls,
        error: result.error ? env.masker.mask(result.error.message) : null,
      });
      writtenCount += statementWrittenCount;
      deletedCount += statementDeletedCount;
      if (result.status === "success") {
        if (result.kind === "EXIT_NO_DATA") sawNoData = true;
        continue;
      }
      if (result.status === "skipped") {
        if (result.skippedReason === "timeout") sawTimeout = true;
        continue;
      }
      // status === "error"
      // ASSERT 文の実行中に API 上限・HTTP エラー等が起きた場合もエンジンは
      // kind: ASSERT_VIOLATION を返すため、真の ASSERT 違反（AssertError）のみ ABORTED に分類する
      if (result.kind === "ASSERT_VIOLATION" && result.error?.code === "AssertError") {
        abortMessage = result.error?.message ?? "ASSERT 条件違反";
        break;
      }
      const cause = result.error?.cause ?? result.error;
      reportExecutionError(params, cause, result.error?.code);
      const classified = classifyRuntimeError(cause);
      failure = {
        message: result.error?.message ?? "実行エラー",
        exitCode: classified,
      };
      if (isTimeoutError(result)) sawTimeout = true;
      break;
    }

    if (abortMessage !== null) {
      status = "ABORTED";
      exitCode = EXIT.ABORTED;
      errorText = abortMessage;
    } else if (sawTimeout) {
      status = "TIMEOUT";
      exitCode = EXIT.RUNTIME;
      errorText = failure?.message ?? `ジョブ timeout (${job.timeoutSec ?? "batch"} 秒) を超過しました`;
    } else if (failure !== null) {
      status = "FAILED";
      exitCode = failure.exitCode;
      errorText = failure.message;
    } else if (sawNoData) {
      status = "NO_DATA";
      exitCode = EXIT.OK;
    }
  } catch (error) {
    // createExecutionContext / executeStatement の同期系エラー
    reportExecutionError(params, error, errorCode(error));
    status = "FAILED";
    exitCode = classifyRuntimeError(error);
    errorText = errorMessage(error);
  } finally {
    if (context !== null) {
      try {
        await disposeExecutionContext(context);
      } catch {
        /* dispose の失敗は結果に影響させない */
      }
    }
  }

  const finishedAt = new Date();
  const apiCallsJob = env.http.snapshot() - apiCallsBefore;
  // 成功文の公開 DML 結果と、失敗文を含む成功済み callback 件数の大きい方が実書込数。
  const actualWrittenCount = Math.max(writtenCount, chunkRows);
  const actualDeletedCount = Math.max(deletedCount, deletedChunkRows);
  const maskedError = errorText !== undefined ? env.masker.mask(errorText) : undefined;

  if (recordId !== null && env.logApp !== null) {
    await env.logApp.finishRecord(recordId, params.jobKey, status, {
      finished_at: toKintoneDateTime(finishedAt),
      duration_sec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
      read_count: readCount,
      written_count: actualWrittenCount,
      deleted_count: actualDeletedCount,
      last_written_key: writeChunks > 0 ? lastWrittenKey ?? `chunk:${writeChunks}` : "",
      api_calls: env.http.snapshot() - apiCallsBefore,
      error_message: maskedError ?? "",
      log_detail: truncateDetail(env.masker.mask(detailLines.join("\n"))),
    });
  }

  env.jsonl.append("job_finish", {
    job: job.name,
    status,
    exitCode,
    readCount,
    writtenCount: actualWrittenCount,
    deletedCount: actualDeletedCount,
    apiCalls: env.http.snapshot() - apiCallsBefore,
    error: maskedError ?? null,
  });

  return {
    ...outcomeBase,
    status,
    exitCode: exitCode as JobOutcome["exitCode"],
    errorMessage: maskedError,
    finishedAt,
    readCount,
    writtenCount: actualWrittenCount,
    deletedCount: actualDeletedCount,
    apiCalls: apiCallsJob,
    lastWrittenKey: writeChunks > 0 ? lastWrittenKey ?? `chunk:${writeChunks}` : undefined,
    writeChunks,
  };
}

function reportExecutionError(params: RunJobParams, cause: unknown, code?: string): void {
  try {
    params.onExecutionError?.(cause, code);
  } catch {
    /* 観測フックの失敗で executor の既存結果を変えない */
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function safeUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

/** DML 結果オブジェクトから書込行数を合算（調査報告 §4-2） */
function writtenRows(result: StatementResult): number {
  if (!isDmlResult(result.result)) return 0;
  return dmlWrittenRows(result.result);
}

function dmlWrittenRows(result: FlowDmlResult): number {
  switch (result.type) {
    case "INSERT":
      return result.insertedCount;
    case "UPDATE":
      return result.updatedCount;
    case "DELETE":
      return result.deletedCount;
    case "UPSERT":
      return result.insertedCount + result.updatedCount;
  }
}

function deletedRows(result: StatementResult): number {
  if (!isDmlResult(result.result) || result.result.type !== "DELETE") return 0;
  return result.result.deletedCount;
}

function isTimeoutError(result: StatementResult): boolean {
  const message = result.error?.message ?? "";
  return /timeout/i.test(result.error?.code ?? "") || /タイムアウト|timed? ?out/i.test(message);
}

/** v3.70.0 の累積 metrics スナップショットから文単位の増分を求める。 */
function metricsDelta(
  current: ExecutionMetrics,
  previous: ExecutionMetrics | null
): { fetchedRows: number; apiCalls: number } {
  return {
    fetchedRows: current.fetchedRows - (previous?.fetchedRows ?? 0),
    apiCalls: metricsApiCalls(current) - (previous === null ? 0 : metricsApiCalls(previous)),
  };
}

function metricsApiCalls(metrics: ExecutionMetrics): number {
  return (
    metrics.getCalls +
    metrics.postCalls +
    metrics.putCalls +
    metrics.deleteCalls +
    metrics.fieldCalls +
    metrics.numberPrecisionCalls +
    metrics.appsCalls +
    metrics.processStatusCalls +
    metrics.cursorCreateCalls +
    metrics.cursorGetCalls +
    metrics.cursorDeleteCalls
  );
}

function maskLastKeyValue(env: RunnerEnv, job: JobFile, info: FlowChunkWrittenInfo): string | undefined {
  if (info.lastKeyValue === undefined) return undefined;
  const statement = job.parsed.statements[info.statementIndex];
  if (
    (statement?.type !== "UPSERT" && statement?.type !== "UPSERT_SELECT") ||
    statement.keyFields.length !== 1
  ) return env.masker.mask(info.lastKeyValue);
  return env.masker.mask(maskFieldValue(env.profile.logging, statement.keyFields[0], info.lastKeyValue));
}

function recordStatementDetail(
  env: RunnerEnv,
  job: JobFile,
  index: number,
  result: StatementResult,
  detailLines: string[]
): void {
  const range = job.parsed.statementRanges[index];
  let sqlText = range !== undefined ? job.source.slice(range.start, range.end).trim() : "";
  if (env.profile.logging.stripLiterals) sqlText = stripSqlLiterals(sqlText);
  const firstLine = sqlText.split("\n")[0] ?? "";
  const suffix =
    result.status === "error"
      ? ` error: ${result.error?.message ?? ""}`
      : result.status === "skipped"
      ? ` skipped (${result.skippedReason ?? ""})`
      : result.kind !== "STATEMENT"
      ? ` ${result.kind}${warningText(result)}`
      : result.rowCount !== undefined
      ? ` rows=${result.rowCount}`
      : "";
  detailLines.push(`#${index + 1} ${result.type}${suffix} | ${firstLine}`);
}

function warningText(result: StatementResult): string {
  if (result.kind !== "ASSERT_WARNING") return "";
  const warning = (result.result as { warning?: unknown } | undefined)?.warning;
  return typeof warning === "string" ? `: ${warning}` : "";
}
