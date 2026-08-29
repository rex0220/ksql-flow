import { validateScript, type Diagnostic } from "@rex0220/kintone-sql-tools/flow";
import { appIdMap, type ResolvedProfile } from "../config";
import { ConfigError, errorMessage } from "../errors";
import { loadJobFile } from "../jobs";
import { EXIT, type ExitCode } from "../types";
import { writeJsonObject } from "./machineJson";

// エンジン公開診断のうち、検出可能な非決定要素を表す code だけを公開する。
// 現時点で乱数等の公開診断 code はなく、独自 code は追加しない。
const NONDETERMINISTIC_DIAGNOSTIC_CODES = new Set(["KSQL1306"]);

export async function inspectJobCommand(profile: ResolvedProfile, filePath: string): Promise<ExitCode> {
  let job: ReturnType<typeof loadJobFile>;
  let diagnostics: Diagnostic[];
  try {
    job = loadJobFile(filePath, appIdMap(profile));
    // parseScript の構文診断に加え、ネットワーク不要の engine semantic 診断
    // (KSQL1305/KSQL1306 等) まで取得する。client/schema は意図的に渡さない。
    diagnostics = await validateScript(job.source, { apps: appIdMap(profile) });
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`ジョブファイルを検査できません: ${filePath} (${errorMessage(error)})`);
  }
  const publicDiagnostics = diagnostics.map(toPublicDiagnostic);

  writeJsonObject({
    formatVersion: 1,
    kind: "JOB_INSPECTION",
    jobId: job.name,
    fileName: job.fileName,
    dialect: job.parsed.meta.dialect,
    statementCount: job.parsed.statements.length,
    dependsOn: job.dependsOn,
    timeoutSec: job.timeoutSec,
    diagnostics: publicDiagnostics,
    nondeterministicElements: publicDiagnostics.filter((diagnostic) =>
      NONDETERMINISTIC_DIAGNOSTIC_CODES.has(diagnostic.code)
    ),
  });
  return EXIT.OK;
}

function toPublicDiagnostic(diagnostic: Diagnostic) {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    line: diagnostic.line,
    column: diagnostic.column,
    message: diagnostic.message,
  };
}
