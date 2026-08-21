import { explainScript } from "@rex0220/kintone-sql-tools/flow";
import { appIdMap } from "../config";
import { errorMessage } from "../errors";
import { RunnerEnvBundle } from "../runner";
import { JobFile } from "../jobs";
import { EXIT, ExitCode } from "../types";
import { validateJob } from "./validate";

/**
 * --dry-run の MVP 縮退版（タスク指示書 §4-4 の調査結論）:
 * validateScript フル検証 + explainScript の推定 API 消費表示。
 * 差分サンプル（INSERT/UPDATE 内訳）はエンジン側依頼 E-2 が通るまで未対応。
 * 読み取り API は消費しない（explainScript の resolveMetadata のみ。metadata GET が発生し得る）。
 */
export async function dryRunJob(
  env: RunnerEnvBundle,
  job: JobFile,
  asOf: Date,
  options: { strict?: boolean } = {}
): Promise<ExitCode> {
  const out = env.out;
  out(`[DRY-RUN] ${job.fileName} (profile: ${env.profile.name}, as-of: ${asOf.toISOString()})`);
  out("  ※ 現バージョンの dry-run は「フル検証 + 推定 API 消費」の縮退版です（差分プレビューは未対応）");

  const diagnostics = await validateJob(env.profile, env.http, job, { strict: options.strict });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  for (const diagnostic of diagnostics) {
    out(`  ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message} (${diagnostic.line}:${diagnostic.column})`);
  }
  if (errors.length > 0) {
    out(`  => 検証エラー ${errors.length} 件のため実行できません`);
    return EXIT.VALIDATION;
  }

  try {
    const plan = await explainScript(job.source, {
      apps: appIdMap(env.profile),
      client: env.client,
      asOf,
      ...(env.profile.timezone !== undefined ? { timezone: env.profile.timezone } : {}),
    });
    out(`  文数: ${plan.statementCount}`);
    for (const statement of plan.statements) {
      out(`  [#${statement.index + 1}] ${statement.type}`);
      for (const line of statement.plan) {
        out(`    ${line}`);
      }
    }
    out(`  ※ 推定 API 消費は HTTP リクエスト単位・書込 100 件/リクエスト（設計書 7.2 / 10.2）`);
  } catch (error) {
    out(`  EXPLAIN の取得に失敗しました: ${errorMessage(error)}`);
    return EXIT.RUNTIME;
  }
  return EXIT.OK;
}
