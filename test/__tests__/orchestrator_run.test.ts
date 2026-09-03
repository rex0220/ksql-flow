import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import Ajv2020 from "ajv/dist/2020";
import { runCommand } from "../../src/commands/run";
import { writeExecutionResult, type ExecutionResult } from "../../src/contract";
import { toKintoneDateTime } from "../../src/logapp";
import { createRunnerEnv } from "../../src/runner";
import { EXIT } from "../../src/types";
import { AS_OF, buildWorld, logRecords, SAMPLE_JOB, type TestWorld, writeJob } from "../helpers/world";

jest.setTimeout(30_000);

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../schema/execution-result-v1.schema.json"), "utf8")
) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addKeyword("x-contract");
const validateResult = ajv.compile(schema);

let world: TestWorld | undefined;

afterEach(() => {
  world?.cleanup();
  world = undefined;
  jest.restoreAllMocks();
});

function expectValidResult(value: unknown): asserts value is ExecutionResult {
  expect(validateResult(value)).toBe(true);
  expect(validateResult.errors).toBeNull();
}

function options(resultJson: string, patch: Record<string, unknown> = {}) {
  return {
    resultJson,
    correlationId: "network_run:001",
    attemptId: "attempt.001",
    expectedJobId: "monthly_sales_sync",
    asOf: AS_OF,
    baseFetch: world!.mock.fetch,
    out: world!.out,
    ...patch,
  };
}

test("markExecutionStarted は writableFields で耐久 marker が欠落した場合 no-op にしない", async () => {
  world = buildWorld({ withOrchestratorFields: false });
  const env = createRunnerEnv(world.profile, { baseFetch: world.mock.fetch, out: world.out });
  await expect(env.logApp?.markExecutionStarted("1", new Date(AS_OF))).rejects.toThrow(
    /EXECUTION_STARTED.*確認できない/
  );
  expect(world.mock.requests.some((request) => request.method === "PUT")).toBe(false);
});

function readResult(file: string): ExecutionResult {
  const bytes = fs.readFileSync(file);
  expect(bytes[0]).not.toBe(0xef);
  expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
  const result = JSON.parse(bytes.toString("utf8")) as unknown;
  expectValidResult(result);
  return result;
}

function toMinute(value: string): number {
  return Math.floor(new Date(value).getTime() / 60_000);
}

function isExecutionStartedPut(input: string | URL | Request, init?: RequestInit): boolean {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if ((init?.method ?? "GET").toUpperCase() !== "PUT" || !url.pathname.endsWith("/records.json")) return false;
  if (typeof init?.body !== "string") return false;
  const body = JSON.parse(init.body) as {
    app?: number;
    records?: Array<{ record?: Record<string, unknown> }>;
  };
  return body.app === 999 && body.records?.some((record) => "runner_execution_started_at" in (record.record ?? {})) === true;
}

function loseDurablePutResponse(options: { loseConfirmationGets?: boolean } = {}): typeof fetch {
  let durablePutPersisted = false;
  return async (input, init) => {
    const response = await world!.mock.fetch(input, init);
    if (isExecutionStartedPut(input, init) && !durablePutPersisted) {
      durablePutPersisted = true;
      throw new TypeError("durable PUT response lost");
    }
    if (durablePutPersisted && options.loseConfirmationGets === true) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const isConfirmationGet =
        (init?.method ?? "GET").toUpperCase() === "GET" &&
        url.pathname.endsWith("/records.json") &&
        url.searchParams.getAll("fields[]").includes("runner_execution_started_at");
      if (isConfirmationGet) throw new TypeError("confirmation GET response lost");
    }
    return response;
  };
}

test("--result-json - は stdout に JSON object 1 個 + LF だけを書き、ID と as-of を echo する", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const chunks: string[] = [];
  const stderr = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);

  const code = await runCommand(world.profile, file, options("-", { out: undefined }));
  expect(stdout).toHaveBeenCalledTimes(1);
  const raw = chunks.join("");
  expect(raw).not.toMatch(/^\uFEFF/);
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw.slice(0, -1)).not.toContain("\n");
  const result = JSON.parse(raw) as unknown;
  expectValidResult(result);
  expect(result).toMatchObject({
    correlationId: "network_run:001",
    attemptId: "attempt.001",
    jobId: "monthly_sales_sync",
    asOf: AS_OF,
    exitCode: code,
    executionStarted: true,
    lastSuccessfulChunkNo: null,
  });
  expect(stderr.mock.calls.flat().join("\n")).toContain("[RUN]");
  expect(stderr.mock.calls.flat().join("\n")).toContain("=> NO_DATA");
});

test("orchestrator preloads and hashes IMPORT bytes before SQL and emits input_files with B178 rows receipt", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
-- @ksql dialect: 1
IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV sales ON DUPLICATE (顧客コード);
`);
  const input = path.join(world.dir, "sales.csv");
  const bytes = Buffer.from("顧客コード,当月売上実績\nC1,100\n", "utf8");
  fs.writeFileSync(input, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(world.dir, "import-result.json");
  expect(await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", hash]]),
  }))).toBe(EXIT.OK);
  const result = readResult(target);
  expect(result.input_files).toEqual([
    { name: "sales", sha256: hash, bytes: bytes.length, rows: 1, encoding: "UTF8" },
  ]);
});

test("B178 rows: quoted改行は1 record、同一sourceを2文が読んでもmetadata同値は1 entry", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
-- @ksql dialect: 1
IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV sales ON DUPLICATE (顧客コード);
IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV sales ON DUPLICATE (顧客コード);
`);
  const input = path.join(world.dir, "sales.csv");
  const bytes = Buffer.from('顧客コード,当月売上実績\n"C1\nX",100\n', "utf8");
  fs.writeFileSync(input, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(world.dir, "quoted.json");
  expect(await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", hash]]),
  }))).toBe(EXIT.OK);
  const result = readResult(target);
  expect(result.input_files).toEqual([
    { name: "sales", sha256: hash, bytes: bytes.length, rows: 1, encoding: "UTF8" },
  ]);
});

test("B178 rows: 1列CSVの末尾空行は空値のdata rowとして+1に数える(engine実測の罠の固定)", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
-- @ksql dialect: 1
IMPORT INTO LAPP_顧客マスタ (顧客コード) FROM CSV sales ON DUPLICATE (顧客コード);
`);
  const input = path.join(world.dir, "sales.csv");
  const bytes = Buffer.from("顧客コード\nC1\n\n", "utf8");
  fs.writeFileSync(input, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(world.dir, "trailing.json");
  await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", hash]]),
  }));
  const result = readResult(target);
  // 成否によらず、materializeまで到達していればrows=2(C1と空値)が載る
  expect(result.input_files).toEqual([
    expect.objectContaining({ name: "sales", sha256: hash, rows: 2, encoding: "UTF8" }),
  ]);
});

test("B178 rows: 同名sourceを異なるENCODINGの2文が読むと解釈ごとの別entryになる(ASCII+NO HEADERで決定的)", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
-- @ksql dialect: 1
IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV sales ENCODING SJIS NO HEADER COLUMNS (顧客コード, 当月売上実績) ON DUPLICATE (顧客コード);
IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV sales ENCODING UTF8 NO HEADER COLUMNS (顧客コード, 当月売上実績) ON DUPLICATE (顧客コード);
`);
  const input = path.join(world.dir, "sales.csv");
  // ASCIIのみのbytesはSJIS/UTF-8どちらでも同一内容にdecodeされ、両文とも成功する
  const bytes = Buffer.from("C1,100\n", "ascii");
  fs.writeFileSync(input, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(world.dir, "encodings.json");
  expect(await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", hash]]),
  }))).toBe(EXIT.OK);
  const result = readResult(target);
  expect(result.input_files).toEqual([
    { name: "sales", sha256: hash, bytes: bytes.length, rows: 1, encoding: "SJIS" },
    { name: "sales", sha256: hash, bytes: bytes.length, rows: 1, encoding: "UTF8" },
  ]);
});

test("B178 rows: SJIS decode失敗はreceipt無し — input_filesはsha256/bytesのみでencodingも載らない", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
-- @ksql dialect: 1
IMPORT INTO LAPP_顧客マスタ (顧客コード) FROM CSV sales ENCODING SJIS ON DUPLICATE (顧客コード);
`);
  const input = path.join(world.dir, "sales.csv");
  // 日本語ヘッダのUTF-8 bytesはSJISとしてdecode不能(invalid SJIS byte sequence)
  const bytes = Buffer.from("顧客コード\nC1\n", "utf8");
  fs.writeFileSync(input, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(world.dir, "sjis-fail.json");
  expect(await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", hash]]),
  }))).not.toBe(EXIT.OK);
  const result = readResult(target);
  expect(result.input_files).toEqual([{ name: "sales", sha256: hash, bytes: bytes.length }]);
  expect(result.input_files[0]).not.toHaveProperty("rows");
  expect(result.input_files[0]).not.toHaveProperty("encoding");
});

test("B178 rows: 多列CSVの空行はdecode throwで通知なし — input_filesはrows無しのまま", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
-- @ksql dialect: 1
IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV sales ON DUPLICATE (顧客コード);
`);
  const input = path.join(world.dir, "sales.csv");
  const bytes = Buffer.from("顧客コード,当月売上実績\nC1,100\n\n", "utf8");
  fs.writeFileSync(input, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(world.dir, "emptyline.json");
  expect(await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", hash]]),
  }))).not.toBe(EXIT.OK);
  const result = readResult(target);
  expect(result.input_files).toEqual([{ name: "sales", sha256: hash, bytes: bytes.length }]);
  expect(result.input_files[0]).not.toHaveProperty("rows");
});

test("orchestrator sha mismatch is INPUT_FILE_MUTATED before execution with zero target mutation", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_import.sql", `-- @ksql name: monthly_sales_sync
IMPORT INTO LAPP_顧客マスタ (顧客コード) FROM CSV sales;
`);
  const input = path.join(world.dir, "sales.csv");
  fs.writeFileSync(input, "顧客コード\nSECRET_CELL\n");
  const target = path.join(world.dir, "mismatch.json");
  expect(await runCommand(world.profile, file, options(target, {
    importSources: [{ name: "sales", kind: "CSV", absolutePath: input }],
    expectedImportSha256: new Map([["sales", "0".repeat(64)]]),
  }))).toBe(EXIT.VALIDATION);
  const result = readResult(target);
  expect(result).toMatchObject({
    resultCode: "INPUT_FILE_MUTATED", executionStarted: false, input_files: [],
    error: { category: "CONFIG", code: "INPUT_FILE_MUTATED" },
  });
  expect(JSON.stringify(result)).not.toContain(input);
  expect(JSON.stringify(result)).not.toContain("SECRET_CELL");
  expect(world.mock.requests.filter((request) =>
    request.appId === 200 && ["POST", "PUT", "DELETE"].includes(request.method)
  )).toHaveLength(0);
});

test("orchestrator JOB と JSONL 全イベントへ相関値を記録し、書込 chunk 数を結果へ渡す", async () => {
  world = buildWorld({
    orders: [{ 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }],
  });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "correlated.json");
  expect(await runCommand(world.profile, file, options(target))).toBe(EXIT.OK);
  const result = readResult(target);
  expect(result.lastSuccessfulChunkNo).toBe(1);

  const job = logRecords(world).find((record) => record.record_type === "JOB");
  expect(job).toMatchObject({
    correlation_id: "network_run:001",
    attempt_id: "attempt.001",
    execution_id: result.executionId,
    batch_id: result.executionId,
    job_id: "monthly_sales_sync",
  });

  const logFile = path.join(world.profile.logging.localDir, `${result.executionId}.jsonl`);
  const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event).toMatchObject({
      correlationId: "network_run:001",
      attemptId: "attempt.001",
      executionId: result.executionId,
    });
  }
  const fieldGets = world.mock.requests.filter(
    (request) => request.appId === 999 && request.method === "GET" && request.path.endsWith("/app/form/fields.json")
  );
  expect(fieldGets).toHaveLength(1);
});

test("耐久 EXECUTION_STARTED を SQL より先に記録し、JOB 値は結果 startedAt と分単位で一致させる", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "durable-start.json");

  expect(await runCommand(world.profile, file, options(target))).toBe(EXIT.OK);
  const result = readResult(target);
  const job = logRecords(world).find((record) => record.record_type === "JOB");
  expect(job?.runner_execution_started_at).toMatch(/:00Z$/);
  expect(toMinute(job!.runner_execution_started_at)).toBe(toMinute(result.startedAt!));

  const markerPutIndex = world.mock.requests.findIndex((request) => {
    if (request.method !== "PUT" || request.appId !== 999) return false;
    const body = request.body as { records?: Array<{ revision?: number; record?: Record<string, unknown> }> };
    return body.records?.some((record) => "runner_execution_started_at" in (record.record ?? {})) === true;
  });
  const firstDataReadIndex = world.mock.requests.findIndex(
    (request) => request.method === "GET" && request.appId === 100 && request.path.endsWith("/records.json")
  );
  expect(markerPutIndex).toBeGreaterThan(-1);
  expect(firstDataReadIndex).toBeGreaterThan(markerPutIndex);
  const markerBody = world.mock.requests[markerPutIndex].body as {
    records: Array<{ revision?: number; record: { runner_execution_started_at: { value: string } } }>;
  };
  expect(markerBody.records[0].revision).toBe(1);
  expect(markerBody.records[0].record.runner_execution_started_at.value)
    .toBe(toKintoneDateTime(new Date(result.startedAt!)));

  const events = fs.readFileSync(
    path.join(world.profile.logging.localDir, `${result.executionId}.jsonl`),
    "utf8"
  ).trim().split("\n").map((line) => JSON.parse(line) as { event: string; startedAt?: string });
  const startIndex = events.findIndex((event) => event.event === "execution_started");
  const statementIndex = events.findIndex((event) => event.event === "statement");
  expect(startIndex).toBeGreaterThan(events.findIndex((event) => event.event === "job_start"));
  expect(statementIndex).toBeGreaterThan(startIndex);
  expect(events[startIndex].startedAt).toBe(result.startedAt);
});

test("EXECUTION_STARTED UPDATE 失敗はデータ API を呼ばず LOCK_UNAVAILABLE で fail-closed", async () => {
  world = buildWorld({ orders: [] });
  world.mock.failNext({
    times: 2,
    status: 500,
    match: (method, requestPath, appId) =>
      method === "PUT" && requestPath.endsWith("/records.json") && appId === 999,
  });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "durable-update-failed.json");

  expect(await runCommand(world.profile, file, options(target))).toBe(EXIT.RUNTIME);
  expect(readResult(target)).toMatchObject({
    resultCode: "LOCK_UNAVAILABLE",
    executionStarted: false,
    startedAt: null,
    exitCode: EXIT.RUNTIME,
  });
  expect(world.mock.requests.filter((request) => request.appId === 100 || request.appId === 200)).toEqual([]);
});

test("EXECUTION_STARTED UPDATE の応答消失後、同一レコード GET で値を確認できれば続行する", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "durable-confirmed.json");

  expect(await runCommand(world.profile, file, options(target, { baseFetch: loseDurablePutResponse() }))).toBe(EXIT.OK);
  const result = readResult(target);
  expect(result).toMatchObject({ resultCode: "NO_DATA", executionStarted: true, exitCode: EXIT.OK });
  const persisted = logRecords(world).find((record) => record.record_type === "JOB")?.runner_execution_started_at;
  expect(persisted).toMatch(/:00Z$/);
  expect(toMinute(persisted!)).toBe(toMinute(result.startedAt!));
  expect(world.mock.requests.some((request) =>
    request.method === "GET" &&
    request.appId === 999 &&
    request.path.endsWith("/records.json") &&
    new URLSearchParams(request.query).getAll("fields[]").includes("runner_execution_started_at")
  )).toBe(true);
});

test("EXECUTION_STARTED UPDATE 応答消失後の再 GET も確認不能なら SQL 未実行で fail-closed", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "durable-unconfirmed.json");

  expect(await runCommand(world.profile, file, options(target, {
    baseFetch: loseDurablePutResponse({ loseConfirmationGets: true }),
  }))).toBe(EXIT.RUNTIME);
  expect(readResult(target)).toMatchObject({
    resultCode: "LOCK_UNAVAILABLE",
    executionStarted: false,
    startedAt: null,
    exitCode: EXIT.RUNTIME,
  });
  expect(world.mock.requests.filter((request) => request.appId === 100 || request.appId === 200)).toEqual([]);
});

test("standalone run は runner_execution_started_at UPDATE を発行しない", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  expect(await runCommand(world.profile, file, {
    asOf: AS_OF,
    baseFetch: world.mock.fetch,
    out: world.out,
  })).toBe(EXIT.OK);
  expect(world.mock.requests.some((request) => {
    if (request.method !== "PUT" || request.appId !== 999) return false;
    const body = request.body as { records?: Array<{ record?: Record<string, unknown> }> };
    return body.records?.some((record) => "runner_execution_started_at" in (record.record ?? {})) === true;
  })).toBe(false);
});

test("旧ログアプリは standalone で従来どおり動作し、orchestrator は SQL 開始前に fail-closed", async () => {
  world = buildWorld({ orders: [], withOrchestratorFields: false });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);

  expect(await runCommand(world.profile, file, {
    asOf: AS_OF,
    baseFetch: world.mock.fetch,
    out: world.out,
  })).toBe(EXIT.OK);
  const standaloneJob = logRecords(world).find((record) => record.record_type === "JOB");
  expect(standaloneJob?.status).toBe("NO_DATA");
  expect(standaloneJob?.correlation_id).toBeUndefined();
  const standaloneEvents = fs.readFileSync(
    path.join(world.profile.logging.localDir, `${standaloneJob!.batch_id}.jsonl`),
    "utf8"
  ).trim().split("\n").map((line) => JSON.parse(line));
  for (const event of standaloneEvents) {
    expect(event.correlationId).toBeUndefined();
    expect(event.attemptId).toBeUndefined();
    expect(event.executionId).toBeUndefined();
  }

  const requestsBefore = world.mock.requests.length;
  const recordsBefore = logRecords(world).length;
  const target = path.join(world.dir, "legacy-fail-closed.json");
  expect(await runCommand(world.profile, file, options(target))).toBe(EXIT.RUNTIME);
  expect(readResult(target)).toMatchObject({
    resultCode: "LOCK_UNAVAILABLE",
    executionStarted: false,
    exitCode: EXIT.RUNTIME,
    lastSuccessfulChunkNo: null,
  });
  expect(logRecords(world)).toHaveLength(recordsBefore);
  expect(world.mock.requests.slice(requestsBefore)).toEqual([
    expect.objectContaining({ method: "GET", appId: 999, path: expect.stringMatching(/app\/form\/fields\.json$/) }),
  ]);
});

test("path 出力は同一ディレクトリの完成済み一時 JSON を fsync 後に rename する", () => {
  world = buildWorld();
  const target = path.join(world.dir, "result.json");
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../fixtures/execution-result/success.json"), "utf8")
  ) as ExecutionResult;
  let synced = false;
  let renamed = 0;
  const fileSystem = {
    existsSync: fs.existsSync,
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    closeSync: fs.closeSync,
    unlinkSync: fs.unlinkSync,
    fsyncSync: (fd: number) => {
      synced = true;
      return fs.fsyncSync(fd);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      renamed += 1;
      expect(synced).toBe(true);
      expect(path.dirname(String(from))).toBe(path.dirname(target));
      expect(to).toBe(path.resolve(target));
      expect(fs.existsSync(target)).toBe(false);
      expectValidResult(JSON.parse(fs.readFileSync(from, "utf8")));
      fs.renameSync(from, to);
    },
  };

  writeExecutionResult(target, fixture, process.stdout, fileSystem);
  expect(renamed).toBe(1);
  expect(readResult(target)).toEqual(fixture);
  expect(fs.readdirSync(world.dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
});

test("stdout が EPIPE でも path 出力は stdout に触れず完成する", () => {
  world = buildWorld();
  const target = path.join(world.dir, "result.json");
  const fixture = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../fixtures/execution-result/success.json"), "utf8")
  ) as ExecutionResult;
  const brokenStdout = {
    write: jest.fn(() => {
      const error = new Error("broken pipe") as NodeJS.ErrnoException;
      error.code = "EPIPE";
      throw error;
    }),
  };

  writeExecutionResult(target, fixture, brokenStdout as Pick<NodeJS.WriteStream, "write">);
  expect(brokenStdout.write).not.toHaveBeenCalled();
  expect(readResult(target)).toEqual(fixture);
});

test("stdout 書込失敗は writer が通知し、run は実行結果の Exit を維持する", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const error = new Error("broken pipe") as NodeJS.ErrnoException;
  error.code = "EPIPE";
  const stdout = jest.spyOn(process.stdout, "write").mockImplementation(() => {
    throw error;
  });
  try {
    expect(() => writeExecutionResult("-", JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../fixtures/execution-result/success.json"), "utf8")
    ) as ExecutionResult)).toThrow(error);

    const code = await runCommand(world.profile, file, options("-", { out: world.out }));
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("Execution Result を出力できません: broken pipe");
  } finally {
    stdout.mockRestore();
  }
});

test("既存 result path は内容を変更せず API 呼出し前に Exit 1 で拒否する", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "result.json");
  fs.writeFileSync(target, "keep-me", "utf8");
  const code = await runCommand(world.profile, file, options(target));
  expect(code).toBe(EXIT.VALIDATION);
  expect(fs.readFileSync(target, "utf8")).toBe("keep-me");
  expect(world.mock.requests).toHaveLength(0);
});

test("controlled validation failure は expected jobId を使い Exit 1 / executionStarted=false", async () => {
  world = buildWorld();
  const file = path.join(world.jobsDir, "missing.sql");
  const target = path.join(world.dir, "validation.json");
  const code = await runCommand(world.profile, file, options(target));
  const result = readResult(target);
  expect(result).toMatchObject({
    jobId: "monthly_sales_sync",
    status: "FAILED",
    resultCode: "VALIDATION_ERROR",
    exitCode: code,
    executionStarted: false,
    startedAt: null,
    apiCalls: 0,
  });
  expect(code).toBe(EXIT.VALIDATION);
});

test("expected job ID 不一致は load 後・ロック/API 前に Exit 1 で拒否する", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_actual.sql", "-- @ksql name: actual_job\nSELECT * FROM LAPP_受注;");
  const target = path.join(world.dir, "mismatch.json");
  const code = await runCommand(world.profile, file, options(target));
  const result = readResult(target);
  expect(code).toBe(EXIT.VALIDATION);
  expect(result).toMatchObject({
    jobId: "monthly_sales_sync",
    resultCode: "VALIDATION_ERROR",
    executionStarted: false,
    exitCode: code,
  });
  expect(world.mock.requests).toHaveLength(0);
});

test("logApp 未設定は API 前に VALIDATION_ERROR で拒否する", async () => {
  world = buildWorld({ withLogApp: false });
  const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
  const target = path.join(world.dir, "no-logapp.json");
  const code = await runCommand(world.profile, file, options(target));
  const result = readResult(target);
  expect(code).toBe(EXIT.VALIDATION);
  expect(result).toMatchObject({ resultCode: "VALIDATION_ERROR", executionStarted: false, exitCode: code });
  expect(world.mock.requests).toHaveLength(0);
});

test("parse failure は先頭 engine diagnostic code を error.code に渡す", async () => {
  world = buildWorld();
  const file = writeJob(world, "01_bad.sql", "-- @ksql name: monthly_sales_sync\nSELECT FROM;");
  const target = path.join(world.dir, "parse.json");
  expect(await runCommand(world.profile, file, options(target))).toBe(EXIT.VALIDATION);
  const result = readResult(target);
  expect(result.executionStarted).toBe(false);
  expect(result.error?.code).toMatch(/^KSQL\d{4}$/);
});

test("ASSERT / API / LOCK_CONFLICT は JSON exitCode とプロセス Exit を一致させる", async () => {
  const cases: Array<{
    label: string;
    makeWorld: () => TestWorld;
    prepare?: (current: TestWorld) => void;
    expectedExit: 2 | 3 | 5;
    resultCode: string;
    executionStarted: boolean;
  }> = [
    {
      label: "ASSERT",
      makeWorld: () => buildWorld({
        orders: [{ 顧客コード: "C1", 金額: "-1", 受注日: "2026-08-05", ステータス: "受注完了" }],
      }),
      expectedExit: 2,
      resultCode: "ASSERT_FAILED",
      executionStarted: true,
    },
    {
      label: "API",
      makeWorld: () => buildWorld({ orders: [] }),
      prepare: (current) => current.mock.failNext({
        times: 2,
        status: 500,
        match: (method, requestPath, appId) =>
          method === "GET" && requestPath.endsWith("/records.json") && appId === 100,
      }),
      expectedExit: 3,
      resultCode: "API_ERROR",
      executionStarted: true,
    },
    {
      label: "LOCK",
      makeWorld: () => buildWorld({
        logRecords: [{
          record_type: "JOB",
          status: "RUNNING",
          job_key: "test:monthly_sales_sync",
          batch_id: "other-batch",
          script_name: "01_monthly.sql",
          profile: "test",
          started_at: toKintoneDateTime(new Date()),
        }],
      }),
      expectedExit: 5,
      resultCode: "LOCK_CONFLICT",
      executionStarted: false,
    },
  ];

  for (const item of cases) {
    world = item.makeWorld();
    item.prepare?.(world);
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const target = path.join(world.dir, `${item.label}.json`);
    const code = await runCommand(world.profile, file, options(target));
    const result = readResult(target);
    expect(result).toMatchObject({
      resultCode: item.resultCode,
      exitCode: code,
      executionStarted: item.executionStarted,
    });
    if (item.label === "API") expect(result.error?.code).toBe("KINTONE_HTTP_500");
    expect(code).toBe(item.expectedExit);
    world.cleanup();
    world = undefined;
  }
});
