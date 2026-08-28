#!/usr/bin/env node
import { loadConfig } from "./config";
import { EXIT } from "./types";
import { errorMessage } from "./errors";
import { validateCommand } from "./commands/validate";
import { runCommand } from "./commands/run";
import { runAllCommand } from "./commands/runAll";
import { unlockCommand } from "./commands/unlock";
import { initLogAppCommand, checkLogAppCommand } from "./commands/initLogapp";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
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
]);

const COMMON_FLAGS = ["--profile", "--config", "--help", "-h"] as const;
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  validate: new Set([...COMMON_FLAGS, "-f", "--file", "--strict", "--check-logapp"]),
  "validate-all": new Set([...COMMON_FLAGS, "--strict"]),
  run: new Set([
    ...COMMON_FLAGS,
    "-f", "--file", "--profile", "--config", "--as-of", "--dry-run", "--sample", "--json",
    "--strict", "--max-api-calls", "--lock", "--force-unlock",
  ]),
  "run-all": new Set([
    ...COMMON_FLAGS,
    "--as-of", "--dry-run", "--sample", "--json", "--strict", "--resume", "--resume-batch", "--from", "--only",
    "--stop-on-error", "--continue-on-error", "--max-api-calls", "--lock", "--force-unlock",
  ]),
  unlock: new Set(COMMON_FLAGS),
  "init-logapp": new Set([...COMMON_FLAGS, "--name"]),
};

const POSITIONAL_COUNTS: Record<string, number> = {
  validate: 0,
  "validate-all": 1,
  run: 0,
  "run-all": 1,
  unlock: 0,
  "init-logapp": 0,
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
      if (VALUE_FLAGS.has(arg)) {
        const value = rest[index + 1];
        if (value === undefined || value.startsWith("-")) {
          throw new Error(`${arg} には値が必要です`);
        }
        flags.set(arg, value);
        index += 1;
      } else {
        flags.set(arg, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "", positional, flags };
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
  if ((args.flags.has("--json") || args.flags.has("--sample")) && !args.flags.has("--dry-run")) {
    throw new Error("--json / --sample は --dry-run との併用時のみ指定できます");
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

const USAGE = `kSQL Flow — kintone バッチランナー (MIT, as-is)

使い方:
  ksql-flow validate -f <file.sql> [--profile p] [--strict] [--check-logapp]
  ksql-flow validate-all <jobsDir> [--profile p] [--strict]
  ksql-flow run -f <file.sql> [--profile p] [--as-of ISO8601] [--dry-run]
                [--sample 1..50] [--json]
                [--max-api-calls N] [--lock local-only] [--force-unlock]
  ksql-flow run-all <jobsDir> [--profile p] [--as-of ISO8601] [--dry-run]
                [--sample 1..50] [--json]
                [--resume | --resume-batch batch_id] [--from file.sql] [--only file.sql]
                [--stop-on-error | --continue-on-error]
                [--max-api-calls N] [--lock local-only] [--force-unlock]
  ksql-flow unlock [--profile p]  # 同一 profile の全 RUNNING を一覧表示後に解除
  ksql-flow init-logapp [--profile p] [--name アプリ名]

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
    console.error(`エラー: ${errorMessage(error)}`);
    console.error("使用方法を確認するには ksql-flow --help を実行してください");
    return EXIT.VALIDATION;
  }

  if (COMMAND_FLAGS[args.command] !== undefined && (boolFlag(args, "--help") || boolFlag(args, "-h"))) {
    console.log(USAGE);
    return EXIT.OK;
  }

  try {
    switch (args.command) {
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
    console.error(`エラー: ${errorMessage(error)}`);
    return typeof exitCode === "number" ? (exitCode as number) : EXIT.RUNTIME;
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
  };
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
