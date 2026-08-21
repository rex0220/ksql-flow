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
  "--max-api-calls",
  "--sample",
  "--lock",
  "--name",
]);

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
                [--resume] [--from file.sql] [--only file.sql]
                [--stop-on-error | --continue-on-error]
                [--max-api-calls N] [--lock local-only] [--force-unlock]
  ksql-flow unlock [--profile p]
  ksql-flow init-logapp [--profile p] [--name アプリ名]

共通フラグ:
  --profile <name>   使用するプロファイル（省略時は defaultProfile）
  --config <path>    設定ファイル（省略時は ./ksql.config.json）

Exit Codes: 0=成功/NO_DATA 1=検証エラー 2=ASSERT違反 3=実行時エラー 4=部分成功 5=多重起動`;

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`エラー: ${errorMessage(error)}`);
    return EXIT.VALIDATION;
  }
  if (
    args.command === "" ||
    args.command === "help" ||
    args.command === "--help" ||
    args.command === "-h" ||
    boolFlag(args, "--help")
  ) {
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
    (code) => process.exit(code),
    (error) => {
      console.error(`エラー: ${errorMessage(error)}`);
      process.exit(EXIT.RUNTIME);
    }
  );
}
