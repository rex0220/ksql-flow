import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { main, parseArgs, validateArgs } from "../../src/cli";
import { EXIT } from "../../src/types";

describe("CLI public contract", () => {
  test("IMPORT flags are repeatable and preserve = in absolute paths", () => {
    const args = parseArgs([
      "run", "-f", "job.sql",
      "--import-csv", "first=C:\\input\\a=b.csv",
      "--import-csv=second=C:\\input\\second.csv",
      "--import-json", "third=C:\\input\\third.json",
    ]);
    expect(args.repeatedFlags.get("--import-csv")).toEqual([
      "first=C:\\input\\a=b.csv", "second=C:\\input\\second.csv",
    ]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  test("EXPORT flags are repeatable and keep equals signs after the first separator", () => {
    const args = parseArgs([
      "run", "-f", "job.sql",
      "--export-csv", "first=C:\\out\\a=b.csv",
      "--export-csv=second=C:\\out\\second.csv",
      "--export-encoding", "sjis", "--export-timezone", "Asia/Tokyo",
    ]);
    expect(args.repeatedFlags.get("--export-csv")).toEqual([
      "first=C:\\out\\a=b.csv", "second=C:\\out\\second.csv",
    ]);
    expect(() => validateArgs(args)).not.toThrow();
  });

  test.each([
    [["run", "-f", "job.sql", "--export-csv", "a.csv", "--export-csv", "b.csv"], /1件/],
    [["run", "-f", "job.sql", "--export-csv", "a=x.csv", "--export-csv", "a=y.csv"], /重複/],
    [["run", "-f", "job.sql", "--export-csv", "a.csv", "--export-encoding", "SJIS"], /utf8.*sjis/],
    [["run", "-f", "job.sql", "--export-csv", "a.csv", "--export-timezone", "Invalid/Zone"], /IANA/],
    [["run", "-f", "job.sql", "--export-csv", "a.csv", "--dry-run"], /dry-run/],
    [["run-all", "jobs", "--export-csv", "a.csv"], /使用できません/],
  ])("rejects invalid or inapplicable EXPORT CLI input", (argv, expected) => {
    expect(() => validateArgs(parseArgs(argv as string[]))).toThrow(expected as RegExp);
  });

  test.each([
    [["run", "-f", "job.sql", "--import-csv", "bad"], /name.*value|形式/],
    [["run", "-f", "job.sql", "--import-csv", "x=relative.csv"], /絶対 path/],
    [["run", "-f", "job.sql", "--import-csv", "x=C:\\a.csv", "--import-json", "x=C:\\a.json"], /重複/],
    [["run", "-f", "job.sql", "--expected-import-sha256", "x=abc"], /64桁/],
  ])("rejects invalid IMPORT CLI input", (argv, expected) => {
    expect(() => validateArgs(parseArgs(argv as string[]))).toThrow(expected as RegExp);
  });

  test("orchestrator requires a one-to-one expected sha256 set", () => {
    const base = [
      "run", "-f", "job.sql", "--result-json", "-", "--correlation-id", "c",
      "--attempt-id", "a", "--expected-job-id", "j", "--import-csv", "sales=C:\\sales.csv",
    ];
    expect(() => validateArgs(parseArgs(base))).toThrow(/expected sha256/);
    expect(() => validateArgs(parseArgs([
      ...base, "--expected-import-sha256", `sales=${"a".repeat(64)}`,
    ]))).not.toThrow();
  });

  test.each([
    ["validate", ["validate", "-f", "job.sql", "--strict", "--check-logapp"]],
    ["validate-all", ["validate-all", "jobs", "--strict"]],
    ["run", ["run", "-f", "job.sql", "--dry-run", "--sample", "5", "--json"]],
    ["run orchestrator", [
      "run", "-f", "job.sql", "--result-json", "-", "--correlation-id", "corr:1",
      "--attempt-id", "attempt.1", "--expected-job-id", "job_1",
    ]],
    ["run-all", ["run-all", "jobs", "--resume-batch", "batch-123", "--stop-on-error"]],
    ["unlock", ["unlock", "--profile", "prod"]],
    ["init-logapp", ["init-logapp", "--name", "実行ログ"]],
    ["capabilities", ["capabilities", "--json"]],
    ["describe-profile", ["describe-profile", "--profile", "prod", "--config", "config.json", "--json"]],
    ["inspect-job", ["inspect-job", "-f", "job.sql", "--profile", "prod", "--config", "config.json", "--json"]],
    ["inspect-lock", ["inspect-lock", "--job-key", "prod:job", "--profile", "prod", "--config", "config.json", "--json"]],
    ["force-unlock-job", [
      "force-unlock-job", "--job-key", "prod:job", "--reason", "stopped", "--confirmed-by", "watchdog",
      "--evidence-ref", "incident://INC-1", "--profile", "prod", "--config", "config.json", "--json",
    ]],
  ])("%s: 許可フラグと positional を受理する", (_command, argv) => {
    expect(() => validateArgs(parseArgs(argv))).not.toThrow();
  });

  test.each([
    ["validate", ["validate", "-f", "job.sql", "--strcit"]],
    ["validate-all", ["validate-all", "jobs", "--check-logapp"]],
    ["run", ["run", "-f", "job.sql", "--dryrun"]],
    ["run-all", ["run-all", "jobs", "--name", "x"]],
    ["unlock", ["unlock", "--force-unlock"]],
    ["init-logapp", ["init-logapp", "--strict"]],
    ["capabilities", ["capabilities", "--config", "config.json"]],
    ["describe-profile", ["describe-profile", "--strict"]],
    ["inspect-job", ["inspect-job", "--sample", "1"]],
    ["inspect-lock", ["inspect-lock", "--force-unlock"]],
    ["force-unlock-job", ["force-unlock-job", "--as-of", "2026-08-30"]],
  ])("%s: 未知または不適用フラグを拒否する", (_command, argv) => {
    expect(() => validateArgs(parseArgs(argv))).toThrow(/未知または不適用/);
  });

  test.each([
    [["run-all", "jobs", "--resume", "--from", "02.sql"], /同時に指定/],
    [["run-all", "jobs", "--resume", "--resume-batch", "batch-123"], /同時に指定/],
    [["run-all", "jobs", "--from", "02.sql", "--only", "03.sql"], /同時に指定/],
    [["run-all", "jobs", "--stop-on-error", "--continue-on-error"], /同時に指定/],
    [["run", "-f", "a.sql", "--file", "b.sql"], /同時に指定/],
    [["run", "-f", "a.sql", "extra.sql"], /余分な positional/],
    [["run-all", "jobs", "extra"], /positional/],
    [["run", "-f", "a.sql", "--json"], /--dry-run/],
    [["run", "-f", "a.sql", "--sample", "5"], /--dry-run/],
  ])("競合・余分 positional・dry-run 専用フラグを拒否する", (argv, message) => {
    expect(() => validateArgs(parseArgs(argv as string[]))).toThrow(message as RegExp);
  });

  test.each([
    [["run", "-f", "a.sql", "--result-json", "-"], /4 フラグは全て/],
    [[
      "run-all", "jobs", "--result-json", "-", "--correlation-id", "c", "--attempt-id", "a",
      "--expected-job-id", "j",
    ], /未知または不適用|run 専用/],
    [[
      "run", "-f", "a.sql", "--dry-run", "--result-json", "-", "--correlation-id", "c",
      "--attempt-id", "a", "--expected-job-id", "j",
    ], /併用できません/],
    [[
      "run", "-f", "a.sql", "--lock", "local-only", "--result-json", "-", "--correlation-id", "c",
      "--attempt-id", "a", "--expected-job-id", "j",
    ], /local-only/],
    [[
      "run", "-f", "a.sql", "--result-json", "-", "--correlation-id", "bad id",
      "--attempt-id", "a", "--expected-job-id", "j",
    ], /A-Za-z0-9/],
  ])("orchestrator モードの全-or-none・run 専用・競合・ID 規則を先行検証する", (argv, message) => {
    expect(() => validateArgs(parseArgs(argv as string[]))).toThrow(message as RegExp);
  });

  test("4 フラグ認識後の CLI validation failure も stdout へ Execution Result だけを返す", async () => {
    const chunks: string[] = [];
    const stdout = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await main([
        "run", "-f", "job.sql", "--dry-run", "--result-json", "-", "--correlation-id", "corr",
        "--attempt-id", "attempt", "--expected-job-id", "job",
      ]);
      expect(code).toBe(EXIT.VALIDATION);
      expect(stdout).toHaveBeenCalledTimes(1);
      const raw = chunks.join("");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw)).toMatchObject({
        correlationId: "corr",
        attemptId: "attempt",
        jobId: "job",
        resultCode: "VALIDATION_ERROR",
        executionStarted: false,
        exitCode: code,
      });
      expect(error).toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      error.mockRestore();
    }
  });

  test("--dryrun typo は設定読取や実行へ進まず Exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-cli-"));
    const previous = process.cwd();
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      process.chdir(dir);
      const code = await main(["run", "-f", "danger.sql", "--dryrun"]);
      expect(code).toBe(EXIT.VALIDATION);
      expect(error.mock.calls.flat().join("\n")).toContain("--dryrun");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      error.mockRestore();
      process.chdir(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["未知フラグ", ["run", "--help", "--bogus"]],
    ["余分な positional", ["run", "--help", "extra"]],
  ])("command help より %s の拒否を優先して Exit 1", async (_label, argv) => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main(argv as string[])).toBe(EXIT.VALIDATION);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("command 付き -h は allowlist 検査後に usage を表示して Exit 0", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await main(["run", "-h"])).toBe(EXIT.OK);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test.each([["--help"], ["-h"], ["help"]])("command なしの %s 単独は usage を表示して Exit 0", async (help) => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await main([help])).toBe(EXIT.OK);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
