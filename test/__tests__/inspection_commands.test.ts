import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { main } from "../../src/cli";
import { sortJsonKeys } from "../../src/commands/machineJson";
import { EXIT } from "../../src/types";

interface CapturedRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function captureMain(argv: string[]): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  const error = jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrChunks.push(args.map(String).join(" "));
  });
  try {
    return { code: await main(argv), stdout: stdoutChunks.join(""), stderr: stderrChunks.join("\n") };
  } finally {
    stdout.mockRestore();
    error.mockRestore();
  }
}

function writeConfig(dir: string): string {
  const configPath = path.join(dir, "secret.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    defaultProfile: "prod",
    profiles: {
      prod: {
        baseUrl: "https://example.cybozu.com///",
        timezone: "Asia/Tokyo",
        guestSpaceId: 42,
        auth: { type: "password", username: "PASSWORD_USER_SECRET", password: "PASSWORD_VALUE_SECRET" },
        basicAuth: { username: "BASIC_USER_SECRET", password: "BASIC_PASSWORD_SECRET" },
        apps: {
          受注: { id: 101, tokens: ["ORDER_TOKEN_SECRET"] },
          実行ログ: { id: 999, tokens: ["LOG_TOKEN_SECRET"] },
        },
        logApp: "実行ログ",
        limits: { maxApiCalls: 321, maxReadRows: 654, maxTempRows: 987, batchTimeoutSec: 1200 },
        retry: { maxAttempts: 7, initialDelayMs: 25, maxDelayMs: 2500, respectRetryAfter: false },
        httpTimeoutMs: 4567,
      },
    },
  }));
  return configPath;
}

describe("KF-03 machine-readable inspection commands", () => {
  let dir: string;
  let configPath: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-inspection-"));
    configPath = writeConfig(dir);
    fetchSpy = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("HTTP must not be called"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("capabilities は config 不要で正直な機能・同梱 schema 参照を JSON 1 個で返す", async () => {
    const previousCwd = process.cwd();
    let run: CapturedRun;
    try {
      process.chdir(dir); // ksql.config.json がない場所でも即答することを実証する。
      run = await captureMain(["capabilities", "--json"]);
    } finally {
      process.chdir(previousCwd);
    }
    expect(run.code).toBe(EXIT.OK);
    expect(run.stdout.endsWith("\n")).toBe(true);
    expect(run.stdout.split("\n")).toHaveLength(2);
    expect(run.stdout).not.toMatch(/\u001b\[/);
    const value = JSON.parse(run.stdout);
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../schema/execution-result-v1.schema.json"), "utf8"));
    expect(value).toMatchObject({
      formatVersion: 1,
      kind: "CAPABILITIES",
      executionContracts: ["ksql-flow.execution/v1"],
      resultSchema: { $id: schema.$id, contract: schema["x-contract"] },
      features: {
        resultJson: true,
        correlationIds: true,
        describeProfile: true,
        inspectJob: true,
        durableExecutionStarted: true,
        gracefulCancel: false,
        jobLockProtocol: "profile-job-v0",
      },
    });
    expect(typeof value.ksqlFlowVersion).toBe("string");
    expect(typeof value.engineVersion).toBe("string");
    expect(run.stderr).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    [["capabilities"], /--json/],
    [["capabilities", "--json", "extra"], /positional/],
    [["capabilities", "--json", "--config", "missing.json"], /未知または不適用/],
  ])("capabilities の引数エラーは stdout 空・Exit 1", async (argv, message) => {
    const run = await captureMain(argv as string[]);
    expect(run.code).toBe(EXIT.VALIDATION);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(message as RegExp);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("describe-profile は allowlist 出力・canonical JSON・正しい app/limits を返す", async () => {
    const argv = ["describe-profile", "--profile", "prod", "--config", configPath, "--json"];
    const first = await captureMain(argv);
    const second = await captureMain(argv);
    expect(first.code).toBe(EXIT.OK);
    expect(second.code).toBe(EXIT.OK);
    expect(second.stdout).toBe(first.stdout);
    const value = JSON.parse(first.stdout);
    expect(value).toEqual({
      apps: { 受注: 101, 実行ログ: 999 },
      baseUrl: "https://example.cybozu.com",
      formatVersion: 1,
      guestSpaceId: 42,
      httpTimeoutMs: 4567,
      kind: "PROFILE_DESCRIPTION",
      limits: { batchTimeoutSec: 1200, maxApiCalls: 321, maxReadRows: 654, maxTempRows: 987 },
      logApp: { appId: 999, name: "実行ログ" },
      profile: "prod",
      retry: { initialDelayMs: 25, maxAttempts: 7, maxDelayMs: 2500, respectRetryAfter: false },
      timezone: "Asia/Tokyo",
    });
    expect(first.stdout).toBe(`${JSON.stringify(sortJsonKeys(value))}\n`);
    for (const secret of [
      "PASSWORD_USER_SECRET", "PASSWORD_VALUE_SECRET", "BASIC_USER_SECRET", "BASIC_PASSWORD_SECRET",
      "ORDER_TOKEN_SECRET", "LOG_TOKEN_SECRET",
    ]) {
      expect(first.stdout).not.toContain(secret);
    }
    expect(first.stdout).not.toMatch(/token|password|basicAuth|clientCert|Authorization/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("describe-profile の config 不備は stdout 空・Exit 1", async () => {
    const run = await captureMain([
      "describe-profile", "--profile", "missing", "--config", configPath, "--json",
    ]);
    expect(run.code).toBe(EXIT.VALIDATION);
    expect(run.stdout).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("inspect-job は構文エラー診断をそのまま返して検査完了 Exit 0", async () => {
    const file = path.join(dir, "broken.sql");
    fs.writeFileSync(file, "-- @ksql name: broken\nSELECT FROM;\n");
    const run = await captureMain([
      "inspect-job", "-f", file, "--profile", "prod", "--config", configPath, "--json",
    ]);
    expect(run.code).toBe(EXIT.OK);
    const value = JSON.parse(run.stdout);
    expect(value).toMatchObject({
      formatVersion: 1,
      kind: "JOB_INSPECTION",
      jobId: "broken",
      fileName: "broken.sql",
      statementCount: 0,
      dependsOn: [],
      timeoutSec: null,
      nondeterministicElements: [],
    });
    expect(value.diagnostics).toEqual([
      expect.objectContaining({ code: "KSQL1202", severity: "error", line: 2, column: 8 }),
    ]);
    expect(value.diagnostics[0].message).toEqual(expect.any(String));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("inspect-job は engine KSQL1306 を非決定要素として列挙する", async () => {
    const file = path.join(dir, "server-time.sql");
    fs.writeFileSync(file, `-- @ksql name: server_time
-- @ksql depends_on: prior_job
-- @ksql timeout: 90
-- @ksql dialect: 1
SELECT $id FROM LAPP_受注 WHERE 作成日時 >= NOW();
`);
    const run = await captureMain([
      "inspect-job", "-f", file, "--profile", "prod", "--config", configPath, "--json",
    ]);
    expect(run.code).toBe(EXIT.OK);
    const value = JSON.parse(run.stdout);
    expect(value).toMatchObject({
      jobId: "server_time",
      dialect: 1,
      statementCount: 1,
      dependsOn: ["prior_job"],
      timeoutSec: 90,
    });
    expect(value.diagnostics.map((item: { code: string }) => item.code)).toContain("KSQL1306");
    expect(value.nondeterministicElements).toEqual([
      expect.objectContaining({ code: "KSQL1306", severity: "warning" }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["存在しない file", (missing: string) => ["inspect-job", "-f", missing, "--profile", "prod", "--config", configPath, "--json"]],
    ["config 不備", (file: string) => ["inspect-job", "-f", file, "--profile", "missing", "--config", configPath, "--json"]],
    ["未定義 logical app", (file: string) => ["inspect-job", "-f", file, "--profile", "prod", "--config", configPath, "--json"]],
  ])("inspect-job の %s は stdout 空・Exit 1", async (_label, args) => {
    const file = path.join(dir, "job.sql");
    fs.writeFileSync(file, _label === "未定義 logical app" ? "SELECT * FROM LAPP_MISSING;\n" : "SELECT $id FROM APP101;\n");
    const argv = args(path.join(dir, _label === "存在しない file" ? "missing.sql" : "job.sql"));
    const run = await captureMain(argv);
    expect(run.code).toBe(EXIT.VALIDATION);
    expect(run.stdout).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
