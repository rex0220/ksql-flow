import * as fs from "fs";
import * as path from "path";
import { parseScript, type ParseScriptResult } from "@rex0220/kintone-sql-tools/flow";
import { ConfigError } from "./errors";

/** エンジンの 1 スクリプト文数上限（申し送り 4: MAX_BATCH_STATEMENTS） */
export const MAX_STATEMENTS = 20;

export interface JobFile {
  /** ジョブ論理名（-- @ksql name、省略時はファイル名から拡張子を除いたもの） */
  name: string;
  /** ファイル名（例: 02_calc_daily_sales.sql） */
  fileName: string;
  filePath: string;
  source: string;
  dependsOn: string[];
  /** @ksql timeout（秒） */
  timeoutSec: number | null;
  parsed: ParseScriptResult;
}

/** 単一の SQL ファイルを読み込み、ヘッダメタを解決する */
export function loadJobFile(filePath: string, apps: Record<string, number>): JobFile {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`ジョブファイルを読み込めません: ${filePath} (${(error as Error).message})`);
  }
  const parsed = parseScript(source, { apps });
  const fileName = path.basename(filePath);
  const name = parsed.meta.name ?? fileName.replace(/\.sql$/i, "");
  return {
    name,
    fileName,
    filePath,
    source,
    dependsOn: parsed.meta.dependsOn,
    timeoutSec: parsed.meta.timeout,
    parsed,
  };
}

/** ジョブディレクトリの *.sql をファイル名順に列挙する（設計書 4 章） */
export function listJobFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    throw new ConfigError(`ジョブディレクトリを読み込めません: ${dir} (${(error as Error).message})`);
  }
  return entries
    .filter((entry) => /\.sql$/i.test(entry))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((entry) => path.join(dir, entry));
}

export function loadJobDir(dir: string, apps: Record<string, number>): JobFile[] {
  const files = listJobFiles(dir);
  if (files.length === 0) {
    throw new ConfigError(`ジョブディレクトリに .sql ファイルがありません: ${dir}`);
  }
  const jobs = files.map((file) => loadJobFile(file, apps));
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const existing = seen.get(job.name);
    if (existing !== undefined) {
      throw new ConfigError(
        `ジョブ論理名 "${job.name}" が重複しています (${existing} / ${job.fileName})`
      );
    }
    seen.set(job.name, job.fileName);
  }
  return jobs;
}

/**
 * depends_on の実行計画を検証する。
 * - 未定義ジョブへの依存・循環依存はエラー（Exit 1）
 * - 依存先がファイル名順で「後」にあるジョブもエラー（初期リリースは順次実行のため実行順で満たせない）
 */
export function validateDependencyGraph(jobs: JobFile[]): void {
  const indexByName = new Map<string, number>();
  jobs.forEach((job, index) => indexByName.set(job.name, index));
  for (const [index, job] of jobs.entries()) {
    for (const dep of job.dependsOn) {
      const depIndex = indexByName.get(dep);
      if (depIndex === undefined) {
        throw new ConfigError(`${job.fileName}: depends_on の "${dep}" が見つかりません`);
      }
      if (depIndex >= index) {
        throw new ConfigError(
          `${job.fileName}: depends_on の "${dep}" がファイル名順で自分より後です（順次実行では依存を満たせません）`
        );
      }
    }
  }
}
