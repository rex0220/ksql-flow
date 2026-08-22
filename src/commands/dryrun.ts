import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  previewStatement,
  validateScript,
  type ExecutionContext,
  type PreviewResult,
  type PreviewSample,
  type StatementResult,
} from "@rex0220/kintone-sql-tools/flow";
import { appIdMap } from "../config";
import { classifyRuntimeError, errorMessage } from "../errors";
import { JobFile, MAX_STATEMENTS } from "../jobs";
import { maskFieldValue } from "../logging/mask";
import { RunnerEnvBundle } from "../runner";
import { EXIT, ExitCode } from "../types";

const DEFAULT_SAMPLES = 5;
const DML_TYPES = new Set(["INSERT", "INSERT_SELECT", "UPDATE", "DELETE", "UPSERT", "UPSERT_SELECT"]);

export interface DryRunSample {
  app: string;
  appId: number;
  operation: PreviewResult["operation"];
  kind: PreviewSample["kind"];
  keyField?: string;
  key?: string;
  before?: Record<string, string>;
  after?: Record<string, string>;
}

export interface DryRunReport {
  formatVersion: 1;
  kind: "DRY_RUN";
  job: string;
  profile: string;
  asOf: string;
  status: "SUCCESS" | "ABORTED" | "NO_DATA" | "FAILED";
  exitCode: ExitCode;
  sampleLimit: number;
  reads: { records: number; apiCalls: number };
  writes: Array<{
    app: string;
    appId: number;
    counts: { insert: number; update: number; delete: number };
    estimatedWrites: number;
  }>;
  actualApiCalls: { total: number; read: number; preview: number };
  samples: DryRunSample[];
  gate?: { kind: "ASSERT" | "EXIT"; message: string };
  incomplete: boolean;
  error?: string;
}

export interface DryRunOptions {
  sample?: number;
  json?: boolean;
  strict?: boolean;
  emit?: boolean;
  onReport?: (report: DryRunReport) => void;
}

/**
 * dry-run 本実装: 単一 ExecutionContext で read-only 文を executeStatement、DML を
 * previewStatement へ振り分ける。ロック・ログアプリ・state 更新は呼出経路上に存在しない。
 */
export async function dryRunJob(
  env: RunnerEnvBundle,
  job: JobFile,
  asOf: Date,
  options: DryRunOptions = {}
): Promise<ExitCode> {
  const sampleLimit = options.sample ?? DEFAULT_SAMPLES;
  const emit = options.emit !== false;
  const apiBefore = env.http.snapshot();
  const writes = new Map<number, DryRunReport["writes"][number]>();
  const samples: DryRunSample[] = [];
  let readRecords = 0;
  let previewApiCalls = 0;
  let status: DryRunReport["status"] = "SUCCESS";
  let exitCode: ExitCode = EXIT.OK;
  let gate: DryRunReport["gate"];
  let failure: string | undefined;
  let incomplete = false;
  let context: ExecutionContext | null = null;
  let previousMetrics: StatementResult["metrics"] | null = null;

  if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 50) {
    status = "FAILED";
    exitCode = EXIT.VALIDATION;
    failure = "--sample は 1〜50 の整数で指定してください";
  } else {
    const parseErrors = job.parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (parseErrors.length > 0 || job.parsed.statements.length > MAX_STATEMENTS) {
      status = "FAILED";
      exitCode = EXIT.VALIDATION;
      failure =
        parseErrors.length > 0
          ? parseErrors.map((item) => `${item.code} ${item.message} (${item.line}:${item.column})`).join("\n")
          : `1 スクリプトの文数上限 (${MAX_STATEMENTS} 文) を超えています`;
    }
  }

  try {
    if (failure === undefined) {
      // dialect 1 の updateKey / サブテーブル等も本実行と同じ prepare 検証を先に通す。
      const diagnostics = await validateScript(job.source, {
        apps: appIdMap(env.profile),
        strict: options.strict,
        client: env.client,
      });
      const validationErrors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (validationErrors.length > 0) {
        status = "FAILED";
        exitCode = validationErrors.some((item) => /maxApiCalls=\d+/.test(item.message))
          ? EXIT.RUNTIME
          : EXIT.VALIDATION;
        failure = validationErrors
          .map((item) => `${item.code} ${item.message} (${item.line}:${item.column})`)
          .join("\n");
      }
    }
    if (failure === undefined) {
      context = createExecutionContext({
        client: env.client,
        statements: job.parsed.statements,
        meta: job.parsed.meta,
        asOf,
        ...(env.profile.timezone !== undefined ? { timezone: env.profile.timezone } : {}),
        ...(job.timeoutSec !== null ? { timeoutMs: job.timeoutSec * 1000 } : {}),
        ...(env.profile.limits.maxTempRows !== null
          ? { tempTableMaxRows: env.profile.limits.maxTempRows }
          : {}),
      });

      for (const statement of job.parsed.statements) {
        if (DML_TYPES.has(statement.type)) {
          const preview = await previewStatement(statement, context, { maxSamples: sampleLimit });
          previewApiCalls += preview.reads;
          mergeWrite(writes, env, preview);
          const keyField = previewKeyField(statement);
          for (const sample of preview.samples) {
            if (samples.length < sampleLimit) samples.push(maskSample(env, preview, sample, keyField));
          }
          env.jsonl.append("dry_run_preview", {
            job: job.name,
            operation: preview.operation,
            appId: preview.appId,
            counts: preview.counts,
            reads: preview.reads,
            estimatedWrites: preview.estimatedWrites,
            samples: preview.samples.map((sample) => maskSample(env, preview, sample, keyField)),
          });
          continue;
        }

        const result = await executeStatement(statement, context);
        const delta = metricsDelta(result.metrics, previousMetrics);
        previousMetrics = result.metrics;
        readRecords += delta.fetchedRows;
        env.jsonl.append("dry_run_statement", {
          job: job.name,
          type: result.type,
          status: result.status,
          kind: result.kind,
          readCount: delta.fetchedRows,
        });

        if (result.kind === "ASSERT_VIOLATION" && result.error?.code === "AssertError") {
          status = "ABORTED";
          exitCode = EXIT.ABORTED;
          gate = { kind: "ASSERT", message: env.masker.mask(result.error.message) };
          break;
        }
        if (result.status === "error") {
          const cause = result.error?.cause ?? result.error;
          status = "FAILED";
          exitCode = classifyRuntimeError(cause);
          failure = env.masker.mask(result.error?.message ?? "dry-run の読み取り文でエラーが発生しました");
          incomplete = true;
          break;
        }
        // EXIT 成立はこの executeStatement の結果で判定し、以降を呼び出さない。
        if (result.kind === "EXIT_NO_DATA") {
          status = "NO_DATA";
          exitCode = EXIT.OK;
          const exitResult = result.result as { message?: unknown } | undefined;
          gate = {
            kind: "EXIT",
            message: env.masker.mask(
              typeof exitResult?.message === "string" ? exitResult.message : "EXIT SUCCESS IF が成立しました"
            ),
          };
          break;
        }
      }
    }
  } catch (error) {
    status = "FAILED";
    exitCode = classifyRuntimeError(error);
    failure = env.masker.mask(errorMessage(error));
    incomplete = true;
  } finally {
    if (context !== null) {
      try {
        await disposeExecutionContext(context);
      } catch {
        // cursor cleanup の失敗はプレビュー結果を上書きしない。
      }
    }
  }

  const totalApiCalls = env.http.snapshot() - apiBefore;
  if (failure !== undefined) failure = env.masker.mask(failure);
  const report: DryRunReport = {
    formatVersion: 1,
    kind: "DRY_RUN",
    job: job.fileName,
    profile: env.profile.name,
    asOf: asOf.toISOString(),
    status,
    exitCode,
    sampleLimit,
    reads: { records: readRecords, apiCalls: Math.max(0, totalApiCalls - previewApiCalls) },
    writes: [...writes.values()],
    actualApiCalls: {
      total: totalApiCalls,
      read: Math.max(0, totalApiCalls - previewApiCalls),
      preview: previewApiCalls,
    },
    samples,
    ...(gate !== undefined ? { gate } : {}),
    incomplete,
    ...(failure !== undefined ? { error: failure } : {}),
  };

  env.jsonl.append("dry_run_finish", { ...report });
  options.onReport?.(report);
  if (emit) {
    if (options.json === true) env.out(JSON.stringify(report));
    else printHuman(env.out, report);
  }
  return exitCode;
}

function mergeWrite(
  writes: Map<number, DryRunReport["writes"][number]>,
  env: RunnerEnvBundle,
  preview: PreviewResult
): void {
  const current = writes.get(preview.appId) ?? {
    app: appName(env, preview.appId),
    appId: preview.appId,
    counts: { insert: 0, update: 0, delete: 0 },
    estimatedWrites: 0,
  };
  current.counts.insert += preview.counts.insert;
  current.counts.update += preview.counts.update;
  current.counts.delete += preview.counts.delete;
  current.estimatedWrites += preview.estimatedWrites;
  writes.set(preview.appId, current);
}

function maskSample(
  env: RunnerEnvBundle,
  preview: PreviewResult,
  sample: PreviewSample,
  keyField: string | undefined
): DryRunSample {
  const maskRecord = (record: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (record === undefined) return undefined;
    return Object.fromEntries(
      Object.entries(record).map(([field, value]) => [field, displayValue(env, field, value)])
    );
  };
  return {
    app: appName(env, preview.appId),
    appId: preview.appId,
    operation: preview.operation,
    kind: sample.kind,
    ...(keyField !== undefined ? { keyField } : {}),
    ...(sample.key !== undefined
      ? { key: displayValue(env, keyField ?? "$id", sample.key) }
      : {}),
    ...(sample.before !== undefined ? { before: maskRecord(sample.before) } : {}),
    ...(sample.after !== undefined ? { after: maskRecord(sample.after) } : {}),
  };
}

function displayValue(env: RunnerEnvBundle, field: string, value: string): string {
  const masked = maskFieldValue(env.profile.logging, field, env.masker.mask(value));
  if (masked === "***") return masked;
  return env.profile.logging.stripLiterals ? "?" : masked;
}

function previewKeyField(statement: { type: string }): string | undefined {
  const keyFields = (statement as unknown as { keyFields?: unknown }).keyFields;
  if ((statement.type === "UPSERT" || statement.type === "UPSERT_SELECT") && Array.isArray(keyFields)) {
    return keyFields.length === 1 && typeof keyFields[0] === "string"
      ? keyFields[0]
      : undefined;
  }
  return statement.type === "DELETE" ? "$id" : undefined;
}

function appName(env: RunnerEnvBundle, appId: number): string {
  const found = Object.entries(env.profile.apps).find(([, definition]) => definition.id === appId);
  return found !== undefined ? `LAPP_${found[0]}` : `APP${appId}`;
}

function metricsDelta(
  current: StatementResult["metrics"],
  previous: StatementResult["metrics"] | null
): { fetchedRows: number } {
  return { fetchedRows: current.fetchedRows - (previous?.fetchedRows ?? 0) };
}

function printHuman(out: (line: string) => void, report: DryRunReport): void {
  out(`[DRY-RUN] ${report.job} (as-of: ${report.asOf})`);
  out(`  読み取り        : ${report.reads.records.toLocaleString("ja-JP")} 件（API ${report.reads.apiCalls} 回）`);
  if (report.writes.length === 0) {
    out("  書き込み予定    : INSERT 0 件 / UPDATE 0 件 / DELETE 0 件");
  } else {
    for (const write of report.writes) {
      out(
        `  書き込み予定    : ${write.app}  INSERT ${write.counts.insert} 件 / ` +
          `UPDATE ${write.counts.update} 件 / DELETE ${write.counts.delete} 件`
      );
    }
  }
  out(
    `  実測 API 消費   : ${report.actualApiCalls.total} 回` +
      `（読取 ${report.actualApiCalls.read} + preview 照合 ${report.actualApiCalls.preview}）`
  );
  out(`  変更サンプル（先頭 ${report.sampleLimit} 件）:`);
  if (report.samples.length === 0) out("    （変更予定なし）");
  for (const sample of report.samples.slice(0, report.sampleLimit)) out(`    ${sampleLine(sample)}`);
  if (report.gate?.kind === "ASSERT") {
    out(`  => この時点で ABORTED になる: ${report.gate.message} (exit 2)`);
  } else if (report.gate?.kind === "EXIT") {
    out(`  => この時点で NO_DATA になる: ${report.gate.message} (exit 0)`);
  } else if (report.error !== undefined) {
    out(`  => 安全停止: ${report.error} (exit ${report.exitCode})`);
  } else {
    out("  => dry-run 完了（kintone 書き込み 0 件）");
  }
}

function sampleLine(sample: DryRunSample): string {
  const key = sample.key !== undefined ? `${sample.keyField ?? "key"}=${sample.key}  ` : "";
  if (sample.kind === "delete") return `${sample.app}  ${key}(削除予定)`;
  const fields = new Set([...Object.keys(sample.before ?? {}), ...Object.keys(sample.after ?? {})]);
  const changes = [...fields].map((field) => {
    const before = sample.before?.[field];
    const after = sample.after?.[field];
    if (sample.kind === "insert") return `${field}: ${after ?? ""}`;
    return `${field}: ${before ?? ""} → ${after ?? ""}`;
  });
  return `${sample.app}  ${key}${sample.kind === "insert" ? "(新規) " : ""}${changes.join(" / ")}`;
}
