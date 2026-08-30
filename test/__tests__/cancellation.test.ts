import * as fs from "fs";
import * as path from "path";
import Ajv2020 from "ajv/dist/2020";
import { withGracefulCancellation, type GracefulSignal } from "../../src/cancellation";
import { runCommand } from "../../src/commands/run";
import { EXIT } from "../../src/types";
import {
  AS_OF,
  buildWorld,
  CUSTOMER_APP,
  logRecords,
  type TestWorld,
  writeJob,
} from "../helpers/world";

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

function emit(signal: GracefulSignal): void {
  process.emit(signal);
}

function bodyOf(init?: RequestInit): {
  app?: number;
  record?: Record<string, { value?: unknown }>;
  records?: Array<Record<string, { value?: unknown }>>;
} {
  return typeof init?.body === "string" ? JSON.parse(init.body) : {};
}

function emitAfterRunningRecord(signal: GracefulSignal): typeof fetch {
  let emitted = false;
  return async (input, init) => {
    const body = bodyOf(init);
    const response = await world!.mock.fetch(input, init);
    if (
      !emitted &&
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      body.app === 999 &&
      (body.record?.status?.value === "RUNNING" || body.records?.[0]?.status?.value === "RUNNING")
    ) {
      emitted = true;
      emit(signal);
    }
    return response;
  };
}

function captureNotifications(): { calls: Array<{ url: string; body: unknown }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    fetch: (async (input, init) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  };
}

const supportedSignals: readonly GracefulSignal[] =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];

test.each(supportedSignals)("%s の 1 回目は cooperative cancel を要求する", async (signal) => {
  await withGracefulCancellation(async (token) => {
    expect(token.requested).toBe(false);
    emit(signal);
    expect(token.requested).toBe(true);
    expect(token.signal).toBe(signal);
  });
});

test("SQL 開始前 cancel は orchestrator 結果を CANCELLED/Exit 3 にし、ログとロックを解放する", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_pre_start.sql", `-- @ksql name: pre_start_cancel
-- @ksql dialect: 1
SELECT 顧客コード FROM LAPP_受注;
`);
  const resultPath = path.join(world.dir, "cancel-result.json");
  const lockPath = path.join(world.dir, ".ksql", "lock-test.json");
  let lockPresentWhenCancelledLogged = false;
  let lockPresentWhenOutcomePrinted = true;
  const cancellingFetch = emitAfterRunningRecord("SIGINT");
  const orderedFetch: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as {
      app?: number;
      records?: Array<{ record?: Record<string, { value?: unknown }> }>;
    } : {};
    if (body.app === 999 && body.records?.[0]?.record?.status?.value === "CANCELLED") {
      lockPresentWhenCancelledLogged = fs.existsSync(lockPath);
    }
    return cancellingFetch(input, init);
  };
  const before = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGBREAK: process.listenerCount("SIGBREAK"),
  };

  const code = await runCommand(world.profile, file, {
    resultJson: resultPath,
    correlationId: "network:cancel",
    attemptId: "attempt:cancel",
    expectedJobId: "pre_start_cancel",
    asOf: AS_OF,
    baseFetch: orderedFetch,
    out: (line) => {
      world!.output.push(line);
      if (line.includes("=> CANCELLED")) lockPresentWhenOutcomePrinted = fs.existsSync(lockPath);
    },
  });

  expect(code).toBe(EXIT.RUNTIME);
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  expect(validateResult(result)).toBe(true);
  expect(result).toMatchObject({
    status: "CANCELLED",
    resultCode: "CANCELLED",
    exitCode: 3,
    executionStarted: false,
    startedAt: null,
  });
  expect(world.mock.requests.filter((request) => request.appId === 100 || request.appId === 200)).toEqual([]);
  expect(logRecords(world)[0]).toMatchObject({ status: "CANCELLED", job_key: "", job_key_done: "test:pre_start_cancel" });
  expect(lockPresentWhenCancelledLogged).toBe(true);
  expect(lockPresentWhenOutcomePrinted).toBe(false);
  expect(fs.existsSync(lockPath)).toBe(false);
  expect(world.output.join("\n")).toContain("CANCELLED (exit 3)");
  expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
  expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  expect(process.listenerCount("SIGBREAK")).toBe(before.SIGBREAK);
});

test("文の request 中 signal は完了を待ち、次の文を開始しない", async () => {
  world = buildWorld({ orders: [{ 顧客コード: "C1", 金額: "100" }] });
  const file = writeJob(world, "01_between_statements.sql", `-- @ksql name: between_statements
-- @ksql dialect: 1
SELECT 顧客コード FROM LAPP_受注;
SELECT 顧客コード FROM LAPP_受注;
`);
  let emitted = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await world!.mock.fetch(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (
      !emitted &&
      (init?.method ?? "GET").toUpperCase() === "GET" &&
      url.pathname.endsWith("/records.json") &&
      url.searchParams.get("app") === "100"
    ) {
      emitted = true;
      emit("SIGINT");
    }
    return response;
  };

  const code = await runCommand(world.profile, file, { asOf: AS_OF, baseFetch: fetchImpl, out: world.out });

  expect(code).toBe(EXIT.RUNTIME);
  const statementReads = world.mock.requests.filter(
    (request) => request.appId === 100 && request.method === "GET" && request.path.endsWith("/records.json")
  );
  expect(statementReads).toHaveLength(1);
  expect(logRecords(world)[0].status).toBe("CANCELLED");
});

test("signal と真のエラーが同時発生しても結果は CANCELLED、元メッセージは JSONL に残す", async () => {
  world = buildWorld({ orders: [] });
  const file = writeJob(world, "01_cancel_error.sql", `-- @ksql name: cancel_error
-- @ksql dialect: 1
SELECT 顧客コード FROM LAPP_受注;
`);
  const resultPath = path.join(world.dir, "cancel-error-result.json");
  let emitted = false;
  const failingFetch: typeof fetch = async (input, init) => {
    const body = bodyOf(init) as {
      app?: number;
      records?: Array<{ record?: Record<string, { value?: unknown }> }>;
    };
    if (
      init?.method === "PUT" &&
      body.app === 999 &&
      body.records?.[0]?.record?.runner_execution_started_at !== undefined
    ) {
      if (!emitted) {
        emitted = true;
        emit("SIGINT");
      }
      throw new TypeError("marker transport exploded");
    }
    return world!.mock.fetch(input, init);
  };

  expect(await runCommand(world.profile, file, {
    resultJson: resultPath,
    correlationId: "network:cancel-error",
    attemptId: "attempt:cancel-error",
    expectedJobId: "cancel_error",
    asOf: AS_OF,
    baseFetch: failingFetch,
    out: world.out,
  })).toBe(EXIT.RUNTIME);

  const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  expect(result).toMatchObject({ status: "CANCELLED", resultCode: "CANCELLED", exitCode: 3 });
  const logFile = path.join(world.profile.logging.localDir, `${String(result.executionId)}.jsonl`);
  const events = fs.readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toContainEqual(expect.objectContaining({
    event: "cancelled_with_error",
    originalErrorMessages: expect.arrayContaining(["marker transport exploded"]),
  }));
});

test("write chunk 完了時の cancel は完了 chunk を確定し、次の書込 API を発行しない", async () => {
  world = buildWorld({});
  const file = writeJob(world, "01_chunk_cancel.sql", upsertValuesJob(250));
  let writes = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = bodyOf(init);
    const response = await world!.mock.fetch(input, init);
    if ((init?.method ?? "GET").toUpperCase() === "PUT" && body.app === CUSTOMER_APP) {
      writes += 1;
      if (writes === 1) emit("SIGINT");
    }
    return response;
  };

  const code = await runCommand(world.profile, file, { asOf: AS_OF, baseFetch: fetchImpl, out: world.out });

  expect(code).toBe(EXIT.RUNTIME);
  expect(writes).toBe(1);
  expect(world.mock.app(CUSTOMER_APP).records).toHaveLength(100);
  expect(logRecords(world)[0]).toMatchObject({ status: "CANCELLED", written_count: "100" });
});

test("利用者 cancel は onFailure を送らず heartbeat: always だけを送る", async () => {
  world = buildWorld({ orders: [] });
  world.profile.notifications = {
    onFailure: { webhook: "https://hooks.example.com/failure" },
    heartbeat: { url: "https://hooks.example.com/heartbeat", on: "always" },
  };
  const notify = captureNotifications();
  const file = writeJob(world, "01_notify_cancel.sql", `-- @ksql name: notify_cancel
-- @ksql dialect: 1
SELECT 顧客コード FROM LAPP_受注;
`);

  expect(await runCommand(world.profile, file, {
    asOf: AS_OF,
    baseFetch: emitAfterRunningRecord("SIGINT"),
    notifyFetch: notify.fetch,
    out: world.out,
  })).toBe(EXIT.RUNTIME);

  expect(logRecords(world)[0]).toMatchObject({ status: "CANCELLED", job_key: "" });
  expect(fs.existsSync(path.join(world.dir, ".ksql", "lock-test.json"))).toBe(false);
  expect(notify.calls).toEqual([
    expect.objectContaining({
      url: "https://hooks.example.com/heartbeat",
      body: expect.objectContaining({ status: "CANCELLED" }),
    }),
  ]);
});

test("cancel 後の別 run は解除済み handler の影響を受けず成功する", async () => {
  world = buildWorld({ orders: [] });
  const cancelled = writeJob(world, "01_first.sql", `-- @ksql name: first
-- @ksql dialect: 1
SELECT 顧客コード FROM LAPP_受注;
`);
  expect(await runCommand(world.profile, cancelled, {
    asOf: AS_OF,
    baseFetch: emitAfterRunningRecord("SIGINT"),
    out: world.out,
  })).toBe(EXIT.RUNTIME);

  const second = writeJob(world, "02_second.sql", `-- @ksql name: second
-- @ksql dialect: 1
SELECT 顧客コード FROM LAPP_受注;
`);
  expect(await runCommand(world.profile, second, {
    asOf: AS_OF,
    baseFetch: world.mock.fetch,
    out: world.out,
  })).toBe(EXIT.OK);
  expect(logRecords(world).map((record) => record.status)).toEqual(["CANCELLED", "SUCCESS"]);
});

test("2 回目の signal は process.exit を明示して forced termination にする", async () => {
  const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await withGracefulCancellation(async () => {
    emit("SIGINT");
    emit("SIGTERM");
  });
  expect(exit).toHaveBeenCalledWith(EXIT.RUNTIME);
});

function upsertValuesJob(count: number): string {
  const values = Array.from(
    { length: count },
    (_, index) => `('C${String(index).padStart(3, "0")}', ${index})`
  ).join(",\n");
  return `-- @ksql name: chunk_cancel
-- @ksql dialect: 1
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績)
VALUES ${values}
KEY (顧客コード);
`;
}
