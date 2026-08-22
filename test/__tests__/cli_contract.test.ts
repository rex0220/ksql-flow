import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { main, parseArgs, validateArgs } from "../../src/cli";
import { EXIT } from "../../src/types";

describe("CLI public contract", () => {
  test.each([
    ["validate", ["validate", "-f", "job.sql", "--strict", "--check-logapp"]],
    ["validate-all", ["validate-all", "jobs", "--strict"]],
    ["run", ["run", "-f", "job.sql", "--dry-run", "--sample", "5", "--json"]],
    ["run-all", ["run-all", "jobs", "--resume", "--stop-on-error"]],
    ["unlock", ["unlock", "--profile", "prod"]],
    ["init-logapp", ["init-logapp", "--name", "実行ログ"]],
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
  ])("%s: 未知または不適用フラグを拒否する", (_command, argv) => {
    expect(() => validateArgs(parseArgs(argv))).toThrow(/未知または不適用/);
  });

  test.each([
    [["run-all", "jobs", "--resume", "--from", "02.sql"], /同時に指定/],
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
