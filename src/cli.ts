#!/usr/bin/env node
import * as fs from "fs";
import { loadConfig } from "./config";
import { EXIT, type ExitCode } from "./types";
import { ConfigError, errorMessage } from "./errors";
import { validateCommand } from "./commands/validate";
import { runCommand, writeOrchestratorStartupFailure, type OrchestratorRunOptions } from "./commands/run";
import { SecretMasker } from "./logging/mask";
import { runAllCommand } from "./commands/runAll";
import { unlockCommand } from "./commands/unlock";
import { initLogAppCommand, checkLogAppCommand } from "./commands/initLogapp";
import { capabilitiesCommand } from "./commands/capabilities";
import { describeProfileCommand } from "./commands/describeProfile";
import { inspectJobCommand } from "./commands/inspectJob";
import { forceUnlockJobCommand, inspectLockCommand } from "./commands/lockRecovery";
import { parseImportInputs } from "./importSources";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  repeatedFlags: Map<string, string[]>;
}

/** 値を取るフラグ（それ以外は boolean フラグ扱い） */
const VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "--profile",
  "--config",
  "--as-of",
  "--from",
  "--only",
  "--resume-batch",
  "--max-api-calls",
  "--sample",
  "--lock",
  "--name",
  "--result-json",
  "--correlation-id",
  "--attempt-id",
  "--expected-job-id",
  "--job-key",
  "--reason",
  "--confirmed-by",
  "--evidence-ref",
  "--import-csv",
  "--import-json",
  "--expected-import-sha256",
]);
const REPEATABLE_VALUE_FLAGS = new Set([
  "--import-csv", "--import-json", "--expected-import-sha256",
]);

const COMMON_FLAGS = ["--profile", "--config", "--help", "-h"] as const;
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  validate: new Set([...COMMON_FLAGS, "-f", "--file", "--strict", "--check-logapp"]),
  "validate-all": new Set([...COMMON_FLAGS, "--strict"]),
  run: new Set([
    ...COMMON_FLAGS,
    "-f", "--file", "--profile", "--config", "--as-of", "--dry-run", "--sample", "--json",
    "--strict", "--max-api-calls", "--lock", "--force-unlock",
    "--result-json", "--correlation-id", "--attempt-id", "--expected-job-id",
    "--import-csv", "--import-json", "--expected-import-sha256",
  ]),
  "run-all": new Set([
    ...COMMON_FLAGS,
    "--as-of", "--dry-run", "--sample", "--json", "--strict", "--resume", "--resume-batch", "--from", "--only",
    "--stop-on-error", "--continue-on-error", "--max-api-calls", "--lock", "--force-unlock",
  ]),
  unlock: new Set(COMMON_FLAGS),
  "init-logapp": new Set([...COMMON_FLAGS, "--name"]),
  capabilities: new Set(["--json", "--help", "-h"]),
  "describe-profile": new Set([...COMMON_FLAGS, "--json"]),
  "inspect-job": new Set([...COMMON_FLAGS, "-f", "--file", "--json"]),
  "inspect-lock": new Set([...COMMON_FLAGS, "--job-key", "--json"]),
  "force-unlock-job": new Set([
    ...COMMON_FLAGS, "--job-key", "--reason", "--confirmed-by", "--evidence-ref", "--json",
  ]),
};

const POSITIONAL_COUNTS: Record<string, number> = {
  validate: 0,
  "validate-all": 1,
  run: 0,
  "run-all": 1,
  unlock: 0,
  "init-logapp": 0,
  capabilities: 0,
  "describe-profile": 0,
  "inspect-job": 0,
  "inspect-lock": 0,
  "force-unlock-job": 0,
};
const MACHINE_JSON_COMMANDS = new Set([
  "capabilities", "describe-profile", "inspect-job", "inspect-lock", "force-unlock-job",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const repeatedFlags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const flag = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        if (REPEATABLE_VALUE_FLAGS.has(flag)) appendRepeated(repeatedFlags, flag, value);
        else flags.set(flag, value);
        continue;
      }
      if (VALUE_FLAGS.has(arg)) {
        const value = rest[index + 1];
        if (value === undefined || (value.startsWith("-") && !(arg === "--result-json" && value === "-"))) {
          throw new Error(`${arg} には値が必要です`);
        }
        if (REPEATABLE_VALUE_FLAGS.has(arg)) appendRepeated(repeatedFlags, arg, value);
        else flags.set(arg, value);
        index += 1;
      } else {
        flags.set(arg, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "", positional, flags, repeatedFlags };
}

function appendRepeated(target: Map<string, string[]>, flag: string, value: string): void {
  target.set(flag, [...(target.get(flag) ?? []), value]);
}

/** API 呼び出しや設定ファイル読取より前に、コマンド固有の CLI 契約を検査する。 */
export function validateArgs(args: ParsedArgs): void {
  const allowed = COMMAND_FLAGS[args.command];
  if (allowed === undefined) return;
  for (const [flag, value] of args.flags) {
    if (!allowed.has(flag)) {
      throw new Error(`コマンド ${args.command} ではフラグ ${flag} を使用できません（未知または不適用）`);
    }
    if (VALUE_FLAGS.has(flag) && typeof value !== "string") {
      throw new Error(`${flag} には値が必要です`);
    }
    if (!VALUE_FLAGS.has(flag) && value !== true) {
      throw new Error(`${flag} は値を取りません`);
    }
  }
  for (const [flag, values] of args.repeatedFlags) {
    if (!allowed.has(flag)) {
      throw new Error(`コマンド ${args.command} ではフラグ ${flag} を使用できません（未知または不適用）`);
    }
    if (values.length === 0) throw new Error(`${flag} には値が必要です`);
  }
  const expected = POSITIONAL_COUNTS[args.command];
  if (args.positional.length !== expected) {
    throw new Error(
      expected === 0
        ? `コマンド ${args.command} に余分な positional 引数があります: ${args.positional.join(" ")}`
        : `コマンド ${args.command} の positional 引数は ${expected} 個必要です（受取: ${args.positional.length} 個）`
    );
  }
  rejectConflict(args, ["-f", "--file"]);
  rejectConflict(args, ["--resume", "--resume-batch", "--from", "--only"]);
  rejectConflict(args, ["--stop-on-error", "--continue-on-error"]);
  if (
    (args.command === "run" || args.command === "run-all") &&
    (args.flags.has("--json") || args.flags.has("--sample")) &&
    !args.flags.has("--dry-run")
  ) {
    throw new Error("--json / --sample は --dry-run との併用時のみ指定できます");
  }
  validateOrchestratorArgs(args);
  validateImportArgs(args);
  validateLockRecoveryArgs(args);
}

function validateImportArgs(args: ParsedArgs): void {
  if (args.command !== "run") return;
  const parsed = parseImportInputs(
    repeatedStringFlags(args, "--import-csv"),
    repeatedStringFlags(args, "--import-json"),
    repeatedStringFlags(args, "--expected-import-sha256")
  );
  const orchestrator = ORCHESTRATOR_FLAGS.every((flag) => args.flags.has(flag));
  if (orchestrator) {
    for (const source of parsed.sources) {
      if (!parsed.expectedSha256.has(source.name)) {
        throw new Error(`IMPORT source "${source.name}" のexpected sha256がありません`);
      }
    }
  }
  for (const name of parsed.expectedSha256.keys()) {
    if (!parsed.sources.some((source) => source.name === name)) {
      throw new Error(`expected sha256 に余剰なIMPORT source "${name}" があります`);
    }
  }
}

function validateLockRecoveryArgs(args: ParsedArgs): void {
  if (args.command !== "inspect-lock" && args.command !== "force-unlock-job") return;
  const required = ["--job-key", "--profile", "--config"];
  if (args.command === "force-unlock-job") required.push("--reason", "--confirmed-by", "--evidence-ref");
  const missing = required.filter((flag) => {
    const value = stringFlag(args, flag);
    return value === undefined || value.trim().length === 0;
  });
  if (!boolFlag(args, "--json")) missing.push("--json");
  if (missing.length > 0) throw new Error(`${args.command} の必須入力がありません: ${missing.join(", ")}`);
  if (args.command === "force-unlock-job") {
    const evidenceRef = stringFlag(args, "--evidence-ref")!;
    try {
      new URL(evidenceRef);
    } catch {
      throw new Error("--evidence-ref は絶対 URI で指定してください");
    }
  }
}

const ORCHESTRATOR_FLAGS = [
  "--result-json",
  "--correlation-id",
  "--attempt-id",
  "--expected-job-id",
] as const;
const ORCHESTRATOR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function validateOrchestratorArgs(args: ParsedArgs): void {
  const present = ORCHESTRATOR_FLAGS.filter((flag) => args.flags.has(flag));
  if (present.length === 0) return;
  if (present.length !== ORCHESTRATOR_FLAGS.length) {
    throw new Error(`orchestrator モードの 4 フラグは全て指定してください（指定済み: ${present.join(", ")}）`);
  }
  if (args.command !== "run") throw new Error("orchestrator モードは run 専用です");
  if (args.flags.has("--help") || args.flags.has("-h")) {
    throw new Error("orchestrator モードは --help / -h と併用できません");
  }
  for (const flag of ["--correlation-id", "--attempt-id", "--expected-job-id"] as const) {
    const value = stringFlag(args, flag);
    if (value === undefined || !ORCHESTRATOR_ID_PATTERN.test(value)) {
      throw new Error(`${flag} は ^[A-Za-z0-9._:-]{1,128}$ に一致する値を指定してください`);
    }
  }
  const resultJson = stringFlag(args, "--result-json");
  if (resultJson === undefined || resultJson.length === 0) throw new Error("--result-json は空にできません");
  if (args.flags.has("--dry-run") || args.flags.has("--json") || args.flags.has("--sample")) {
    throw new Error("orchestrator モードは --dry-run / --json / --sample と併用できません");
  }
  if (stringFlag(args, "--lock") === "local-only") {
    throw new Error("orchestrator モードは --lock local-only と併用できません");
  }
  if (resultJson !== "-" && fs.existsSync(resultJson)) {
    throw new Error(`Execution Result の出力先は既に存在します: ${resultJson}`);
  }
}

function rejectConflict(args: ParsedArgs, flags: string[]): void {
  const present = flags.filter((flag) => args.flags.has(flag));
  if (present.length > 1) {
    throw new Error(`${present.join(" / ")} は同時に指定できません`);
  }
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

function repeatedStringFlags(args: ParsedArgs, name: string): string[] {
  return args.repeatedFlags.get(name) ?? [];
}

const USAGE = `kSQL Flow — kintone バッチランナー (MIT, as-is)

使い方:
  ksql-flow validate -f <file.sql> [--profile p] [--strict] [--check-logapp]
  ksql-flow validate-all <jobsDir> [--profile p] [--strict]
  ksql-flow run -f <file.sql> [--profile p] [--as-of ISO8601] [--dry-run]
                [--sample 1..50] [--json]
                [--max-api-calls N] [--lock local-only] [--force-unlock]
                [--result-json <path|-> --correlation-id <id>
                 --attempt-id <id> --expected-job-id <id>]
                [--import-csv <name>=<absolute-path>]...
                [--import-json <name>=<absolute-path>]...
                [--expected-import-sha256 <name>=<64hex>]...
  ksql-flow run-all <jobsDir> [--profile p] [--as-of ISO8601] [--dry-run]
                [--sample 1..50] [--json]
                [--resume | --resume-batch batch_id] [--from file.sql] [--only file.sql]
                [--stop-on-error | --continue-on-error]
                [--max-api-calls N] [--lock local-only] [--force-unlock]
  ksql-flow unlock [--profile p]  # 同一 profile の全 RUNNING を一覧表示後に解除
  ksql-flow init-logapp [--profile p] [--name アプリ名]
  ksql-flow capabilities --json
  ksql-flow describe-profile --profile <p> --config <path> --json
  ksql-flow inspect-job -f <file.sql> --profile <p> --config <path> --json
  ksql-flow inspect-lock --job-key <key> --profile <p> --config <path> --json
  ksql-flow force-unlock-job --job-key <key> --reason <text> --confirmed-by <name>
                --evidence-ref <uri> --profile <p> --config <path> --json

共通フラグ:
  --profile <name>   使用するプロファイル（省略時は defaultProfile）
  --config <path>    設定ファイル（省略時は ./ksql.config.json）

注意:
  unlock / --force-unlock は同一 profile の全 RUNNING が対象です（解除前に一覧表示）。
  --resume / --resume-batch / --from / --only は相互排他、--json / --sample は --dry-run 専用です。

Exit Codes: 0=成功/NO_DATA 1=検証エラー 2=ASSERT違反 3=実行時エラー 4=部分成功 5=多重起動`;

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`エラー: ${errorMessage(error)}`);
    return EXIT.VALIDATION;
  }
  const standaloneHelp =
    (args.command === "help" || args.command === "--help" || args.command === "-h") &&
    args.positional.length === 0 &&
    args.flags.size === 0;
  if (args.command === "" || standaloneHelp) {
    console.log(USAGE);
    return EXIT.OK;
  }

  try {
    validateArgs(args);
  } catch (error) {
    const orchestrator = orchestratorOptionsFromArgs(args);
    if (orchestrator !== null) {
      return writeOrchestratorStartupFailure(
        orchestrator,
        stringFlag(args, "--profile") ?? "default",
        error,
        EXIT.VALIDATION
      );
    }
    console.error(`エラー: ${errorMessage(error)}`);
    console.error("使用方法を確認するには ksql-flow --help を実行してください");
    return EXIT.VALIDATION;
  }

  if (COMMAND_FLAGS[args.command] !== undefined && (boolFlag(args, "--help") || boolFlag(args, "-h"))) {
    if (MACHINE_JSON_COMMANDS.has(args.command)) console.error(USAGE);
    else console.log(USAGE);
    return EXIT.OK;
  }

  try {
    switch (args.command) {
      case "capabilities": {
        requireJsonFlag(args);
        return capabilitiesCommand();
      }
      case "describe-profile": {
        requireJsonFlag(args);
        requireExplicitProfileAndConfig(args);
        return describeProfileCommand(loadProfile(args));
      }
      case "inspect-job": {
        requireJsonFlag(args);
        requireExplicitProfileAndConfig(args);
        const file = stringFlag(args, "-f") ?? stringFlag(args, "--file");
        if (!file) throw new ConfigError("inspect-job には -f <file.sql> が必要です");
        return await inspectJobCommand(loadProfile(args), file);
      }
      case "inspect-lock": {
        requireJsonFlag(args);
        requireExplicitProfileAndConfig(args);
        return await inspectLockCommand(loadProfile(args), stringFlag(args, "--job-key")!);
      }
      case "force-unlock-job": {
        requireJsonFlag(args);
        requireExplicitProfileAndConfig(args);
        return await forceUnlockJobCommand(loadProfile(args), {
          jobKey: stringFlag(args, "--job-key")!,
          reason: stringFlag(args, "--reason")!,
          confirmedBy: stringFlag(args, "--confirmed-by")!,
          evidenceRef: stringFlag(args, "--evidence-ref")!,
        });
      }
      case "validate": {
        const profile = loadProfile(args);
        if (boolFlag(args, "--check-logapp")) {
          return await checkLogAppCommand(profile);
        }
        const file = stringFlag(args, "-f") ?? stringFlag(args, "--file");
        if (!file) {
          console.error("エラー: validate には -f <file.sql> が必要です");
          return EXIT.VALIDATION;
        }
        return await validateCommand(profile, [file], { strict: boolFlag(args, "--strict") });
      }
      case "validate-all": {
        const profile = loadProfile(args);
        const dir = args.positional[0];
        if (!dir) {
          console.error("エラー: validate-all には <jobsDir> が必要です");
          return EXIT.VALIDATION;
        }
        return await validateCommand(profile, { dir }, { strict: boolFlag(args, "--strict") });
      }
      case "run": {
        const profile = loadProfile(args);
        const file = stringFlag(args, "-f") ?? stringFlag(args, "--file");
        if (!file) {
          const orchestrator = orchestratorOptionsFromArgs(args);
          if (orchestrator !== null) {
            return writeOrchestratorStartupFailure(
              orchestrator,
              profile.name,
              new Error("run には -f <file.sql> が必要です"),
              EXIT.VALIDATION,
              new SecretMasker(profile)
            );
          }
          console.error("エラー: run には -f <file.sql> が必要です");
          return EXIT.VALIDATION;
        }
        return await runCommand(profile, file, runOptionsFromArgs(args));
      }
      case "run-all": {
        const profile = loadProfile(args);
        const dir = args.positional[0];
        if (!dir) {
          console.error("エラー: run-all には <jobsDir> が必要です");
          return EXIT.VALIDATION;
        }
        return await runAllCommand(profile, dir, {
          ...runOptionsFromArgs(args),
          resume: boolFlag(args, "--resume"),
          resumeBatch: stringFlag(args, "--resume-batch"),
          from: stringFlag(args, "--from"),
          only: stringFlag(args, "--only"),
          stopOnError: boolFlag(args, "--stop-on-error"),
          continueOnError: boolFlag(args, "--continue-on-error"),
        });
      }
      case "unlock": {
        const profile = loadProfile(args);
        return await unlockCommand(profile);
      }
      case "init-logapp": {
        const profile = loadProfile(args);
        return await initLogAppCommand(profile, { name: stringFlag(args, "--name") });
      }
      default:
        console.error(`エラー: 不明なコマンド "${args.command}"\n`);
        console.log(USAGE);
        return EXIT.VALIDATION;
    }
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    const orchestrator = orchestratorOptionsFromArgs(args);
    if (orchestrator !== null) {
      return writeOrchestratorStartupFailure(
        orchestrator,
        stringFlag(args, "--profile") ?? "default",
        error,
        typeof exitCode === "number" ? (exitCode as ExitCode) : EXIT.RUNTIME
      );
    }
    console.error(`エラー: ${errorMessage(error)}`);
    return typeof exitCode === "number" ? (exitCode as number) : EXIT.RUNTIME;
  }
}

function requireJsonFlag(args: ParsedArgs): void {
  if (!boolFlag(args, "--json")) throw new ConfigError(`${args.command} には --json が必要です`);
}

function requireExplicitProfileAndConfig(args: ParsedArgs): void {
  if (stringFlag(args, "--profile") === undefined || stringFlag(args, "--config") === undefined) {
    throw new ConfigError(`${args.command} には --profile <p> と --config <path> が必要です`);
  }
}

function loadProfile(args: ParsedArgs) {
  return loadConfig({
    configPath: stringFlag(args, "--config"),
    profile: stringFlag(args, "--profile"),
  });
}

function runOptionsFromArgs(args: ParsedArgs) {
  const maxApiCalls = stringFlag(args, "--max-api-calls");
  const sample = stringFlag(args, "--sample");
  const lock = stringFlag(args, "--lock");
  const orchestrator = orchestratorOptionsFromArgs(args);
  const imports = parseImportInputs(
    repeatedStringFlags(args, "--import-csv"),
    repeatedStringFlags(args, "--import-json"),
    repeatedStringFlags(args, "--expected-import-sha256")
  );
  const hasImportOptions = imports.sources.length > 0 || imports.expectedSha256.size > 0;
  if (lock !== undefined && lock !== "local-only") {
    throw Object.assign(new Error(`--lock の値が不正です: ${lock}（指定できるのは local-only のみ）`), {
      exitCode: EXIT.VALIDATION,
    });
  }
  return {
    asOf: stringFlag(args, "--as-of"),
    dryRun: boolFlag(args, "--dry-run"),
    strict: boolFlag(args, "--strict"),
    maxApiCalls: maxApiCalls !== undefined ? Number(maxApiCalls) : undefined,
    sample: sample !== undefined ? Number(sample) : undefined,
    json: boolFlag(args, "--json"),
    lockLocalOnly: lock === "local-only",
    forceUnlock: boolFlag(args, "--force-unlock"),
    ...(hasImportOptions ? {
      importSources: imports.sources,
      expectedImportSha256: imports.expectedSha256,
    } : {}),
    ...(orchestrator ?? {}),
  };
}

function orchestratorOptionsFromArgs(
  args: ParsedArgs
): Pick<OrchestratorRunOptions, "resultJson" | "correlationId" | "attemptId" | "expectedJobId" | "asOf"> | null {
  const resultJson = stringFlag(args, "--result-json");
  const correlationId = stringFlag(args, "--correlation-id");
  const attemptId = stringFlag(args, "--attempt-id");
  const expectedJobId = stringFlag(args, "--expected-job-id");
  if (
    resultJson === undefined ||
    correlationId === undefined ||
    attemptId === undefined ||
    expectedJobId === undefined ||
    !ORCHESTRATOR_ID_PATTERN.test(correlationId) ||
    !ORCHESTRATOR_ID_PATTERN.test(attemptId) ||
    !ORCHESTRATOR_ID_PATTERN.test(expectedJobId)
  ) {
    return null;
  }
  return { resultJson, correlationId, attemptId, expectedJobId, asOf: stringFlag(args, "--as-of") };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`エラー: ${errorMessage(error)}`);
      process.exitCode = EXIT.RUNTIME;
    }
  );
}
