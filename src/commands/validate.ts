import {
  createKintoneClient,
  validateScript,
  type Diagnostic,
} from "@rex0220/kintone-sql-tools/flow";
import { appIdMap, ResolvedProfile } from "../config";
import { EXIT, ExitCode } from "../types";
import { createHttpLayer, engineClientConfig, HttpLayer } from "../http";
import { JobFile, loadJobDir, loadJobFile, MAX_STATEMENTS, validateDependencyGraph } from "../jobs";
import { errorMessage } from "../errors";
import { buildBatchJobKey, buildJobKey } from "../jobkey";

export interface ValidateOptions {
  strict?: boolean;
  /** テスト用 fetch 差し替え */
  baseFetch?: typeof fetch;
  out?: (line: string) => void;
}

/** validate / validate-all の共通実装。Exit 0 / 1 のみを返す（タスク指示書 M1） */
export async function validateCommand(
  profile: ResolvedProfile,
  files: string[] | { dir: string },
  options: ValidateOptions = {}
): Promise<ExitCode> {
  const out = options.out ?? ((line: string) => console.log(line));
  const apps = appIdMap(profile);
  const http = createHttpLayer({
    retry: profile.retry,
    maxApiCalls: profile.limits.maxApiCalls,
    attemptTimeoutMs: profile.httpTimeoutMs,
    basicAuth: profile.basicAuth,
    baseFetch: options.baseFetch,
  });

  let jobs: JobFile[];
  try {
    if (Array.isArray(files)) {
      jobs = files.map((file) => loadJobFile(file, apps));
    } else {
      jobs = loadJobDir(files.dir, apps);
      validateDependencyGraph(jobs);
      buildBatchJobKey(profile.name);
    }
    for (const job of jobs) buildJobKey(profile.name, job.name);
  } catch (error) {
    out(`エラー: ${errorMessage(error)}`);
    return EXIT.VALIDATION;
  }

  let hasError = false;
  for (const job of jobs) {
    const diagnostics = await validateJob(profile, http, job, options);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
    if (errors.length > 0) hasError = true;
    const summary = errors.length === 0
      ? warnings.length === 0 ? "OK" : `OK (警告 ${warnings.length} 件)`
      : `NG (エラー ${errors.length} 件 / 警告 ${warnings.length} 件)`;
    out(`${job.fileName}: ${summary}`);
    for (const diagnostic of diagnostics) {
      out(`  ${formatDiagnostic(job, diagnostic)}`);
    }
  }
  return hasError ? EXIT.VALIDATION : EXIT.OK;
}

/**
 * 1 ジョブのフル検証（申し送り 4: validateScript(source, { client }) で updateKey 等の
 * スキーマ依存検証まで行う）。文数上限はランナー側でも分かりやすく表面化させる。
 */
export async function validateJob(
  profile: ResolvedProfile,
  http: HttpLayer,
  job: JobFile,
  options: { strict?: boolean } = {}
): Promise<Diagnostic[]> {
  const apps = appIdMap(profile);
  const diagnostics: Diagnostic[] = [];
  if (job.parsed.statements.length > MAX_STATEMENTS) {
    diagnostics.push({
      severity: "error",
      code: "KSQL1201",
      message: `1 スクリプトの文数上限 (${MAX_STATEMENTS} 文) を超えています (${job.parsed.statements.length} 文)。ジョブを分割してください`,
      line: 1,
      column: 1,
    });
  }
  try {
    const client = createKintoneClient(engineClientConfig(profile, http));
    const result = await validateScript(job.source, {
      apps,
      strict: options.strict,
      client,
    });
    diagnostics.push(...result);
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "KSQL1201",
      message: `検証中にエラーが発生しました: ${errorMessage(error)}`,
      line: 1,
      column: 1,
    });
  }
  return diagnostics;
}

export function formatDiagnostic(job: JobFile, diagnostic: Diagnostic): string {
  const severity = diagnostic.severity === "error" ? "error" : "warning";
  return `${job.fileName}:${diagnostic.line}:${diagnostic.column} ${severity} ${diagnostic.code} ${diagnostic.message}`;
}
