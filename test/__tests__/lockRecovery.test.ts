import { main, parseArgs, validateArgs } from "../../src/cli";
import { forceUnlockJobCommand, inspectLockCommand } from "../../src/commands/lockRecovery";
import { buildWorld, LOG_APP, logRecords, type TestWorld } from "../helpers/world";

const JOB_KEY = "test:monthly_sales_sync";
const NOW = new Date("2026-08-30T01:02:03.000Z");

function runningRecord(overrides: Record<string, string> = {}) {
  return {
    record_type: "JOB",
    status: "RUNNING",
    job_key: JOB_KEY,
    batch_id: "batch-old",
    started_at: "2026-08-30T00:00:00Z",
    host: "worker-01",
    script_name: "monthly.sql",
    profile: "test",
    ...overrides,
  };
}

describe("KF-06 inspect-lock", () => {
  let world: TestWorld;
  afterEach(() => world?.cleanup());

  test("RUNNING ありは record id・batch・started_at・host・script_name を純 JSON で返す", async () => {
    world = buildWorld({ logRecords: [runningRecord()] });
    const output: Record<string, unknown>[] = [];
    const code = await inspectLockCommand(world.profile, JOB_KEY, {
      baseFetch: world.mock.fetch,
      now: () => NOW,
      writeJson: (value) => output.push(value),
    });

    expect(code).toBe(0);
    expect(output).toEqual([{
      kind: "LOCK_INSPECTION_RESULT",
      formatVersion: 1,
      jobKey: JOB_KEY,
      locked: true,
      record: {
        recordId: "1",
        batchId: "batch-old",
        startedAt: "2026-08-30T00:00:00Z",
        host: "worker-01",
        scriptName: "monthly.sql",
      },
      inspectedAt: NOW.toISOString(),
    }]);
    expect(world.mock.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("RUNNING なしは locked=false、到達不能は locked=null / Exit 3", async () => {
    world = buildWorld();
    const output: Record<string, unknown>[] = [];
    expect(await inspectLockCommand(world.profile, JOB_KEY, {
      baseFetch: world.mock.fetch, now: () => NOW, writeJson: (value) => output.push(value),
    })).toBe(0);
    expect(output[0]).toMatchObject({ locked: false, record: null });

    world.mock.failNext({ status: 401, match: (method, path) => method === "GET" && path.endsWith("/records.json") });
    expect(await inspectLockCommand(world.profile, JOB_KEY, {
      baseFetch: world.mock.fetch, now: () => NOW, writeJson: (value) => output.push(value),
    })).toBe(3);
    expect(output[1]).toMatchObject({ locked: null, error: { code: "LOCK_QUERY_UNAVAILABLE" } });
  });

  test("stdout は JSON object 1 個 + LF のみ", async () => {
    world = buildWorld({ logRecords: [runningRecord()] });
    const chunks: string[] = [];
    const stdout = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await inspectLockCommand(world.profile, JOB_KEY, {
        baseFetch: world.mock.fetch, now: () => NOW,
      })).toBe(0);
      expect(stdout).toHaveBeenCalledTimes(1);
      const raw = chunks.join("");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.slice(0, -1)).not.toContain("\n");
      expect(JSON.parse(raw)).toMatchObject({ kind: "LOCK_INSPECTION_RESULT", locked: true });
    } finally {
      stdout.mockRestore();
    }
  });
});

describe("KF-06 force-unlock-job", () => {
  let world: TestWorld;
  afterEach(() => world?.cleanup());

  const input = {
    jobKey: JOB_KEY,
    reason: "旧 worker の停止を確認",
    confirmedBy: "FlowNet watchdog",
    evidenceRef: "incident://INC-2048",
  };

  test("必須入力欠落は config 読取・API 呼出より前に Exit 1 で拒否する", async () => {
    world = buildWorld({ logRecords: [runningRecord()] });
    const stderr = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await main([
      "force-unlock-job", "--job-key", JOB_KEY,
      "--confirmed-by", "operator", "--evidence-ref", "incident://INC-1",
      "--profile", "test", "--config", "does-not-exist.json", "--json",
    ]);
    stderr.mockRestore();
    expect(code).toBe(1);
    expect(world.mock.requests).toHaveLength(0);

    expect(() => validateArgs(parseArgs([
      "force-unlock-job", "--job-key", JOB_KEY, "--reason", "r",
      "--confirmed-by", "c", "--evidence-ref", "not a uri",
      "--profile", "test", "--config", "x", "--json",
    ]))).toThrow("絶対 URI");
  });

  test("RELEASED は対象 1 件を revision 付き単一 UPDATE し、監査入力を全て残す", async () => {
    world = buildWorld({ logRecords: [runningRecord(), runningRecord({ job_key: "test:other", batch_id: "batch-other" })] });
    const output: Record<string, unknown>[] = [];
    const code = await forceUnlockJobCommand(world.profile, input, {
      baseFetch: world.mock.fetch,
      now: () => NOW,
      writeJson: (value) => output.push(value),
    });

    expect(code).toBe(0);
    expect(output[0]).toMatchObject({
      kind: "LOCK_RECOVERY_RESULT", formatVersion: 1, jobKey: JOB_KEY,
      recordId: "1", outcome: "RELEASED",
      before: { batchId: "batch-old", startedAt: "2026-08-30T00:00:00Z", host: "worker-01" },
      executedAt: NOW.toISOString(),
    });
    const puts = world.mock.requests.filter((request) => request.method === "PUT" && request.appId === LOG_APP);
    expect(puts).toHaveLength(1);
    const body = puts[0].body as { records: Array<{ id: number; revision: number; record: Record<string, { value: string }> }> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ id: 1, revision: 1 });
    expect(body.records[0].record).toMatchObject({
      status: { value: "FAILED" }, job_key: { value: "" }, job_key_done: { value: JOB_KEY },
    });
    const detail = body.records[0].record.log_detail.value;
    expect(detail).toContain(input.reason);
    expect(detail).toContain(input.confirmedBy);
    expect(detail).toContain(input.evidenceRef);
    expect(detail).toContain("profile:test");
    expect(detail).toContain("2026-08-30T01:02:03Z");
    expect(logRecords(world)[0]).toMatchObject({ status: "FAILED", job_key: "", job_key_done: JOB_KEY });
    expect(logRecords(world)[1]).toMatchObject({ status: "RUNNING", job_key: "test:other" });
  });

  test("NOT_FOUND / NOT_RUNNING は UPDATE せず Exit 0", async () => {
    world = buildWorld();
    const output: Record<string, unknown>[] = [];
    expect(await forceUnlockJobCommand(world.profile, input, {
      baseFetch: world.mock.fetch, now: () => NOW, writeJson: (value) => output.push(value),
    })).toBe(0);
    expect(output[0]).toMatchObject({ outcome: "NOT_FOUND", recordId: null });

    world.cleanup();
    world = buildWorld({ logRecords: [runningRecord({ status: "FAILED" })] });
    expect(await forceUnlockJobCommand(world.profile, input, {
      baseFetch: world.mock.fetch, now: () => NOW, writeJson: (value) => output.push(value),
    })).toBe(0);
    expect(output[1]).toMatchObject({ outcome: "NOT_RUNNING", recordId: "1" });
    expect(world.mock.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  test("revision 競合は CONFLICT / Exit 5 で対象を解除しない", async () => {
    world = buildWorld({ logRecords: [runningRecord()] });
    let recordGets = 0;
    const racingFetch: typeof fetch = async (request, init) => {
      const response = await world.mock.fetch(request, init);
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url);
      if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/records.json")) {
        recordGets += 1;
        if (recordGets === 2) world.mock.app(LOG_APP).records[0].revision += 1;
      }
      return response;
    };
    const output: Record<string, unknown>[] = [];
    const code = await forceUnlockJobCommand(world.profile, input, {
      baseFetch: racingFetch, now: () => NOW, writeJson: (value) => output.push(value),
    });
    expect(code).toBe(5);
    expect(output[0]).toMatchObject({ outcome: "CONFLICT" });
    expect(logRecords(world)[0]).toMatchObject({ status: "RUNNING", job_key: JOB_KEY });
  });

  test("UPDATE 応答消失は再 GET でクリア済みなら RELEASED", async () => {
    world = buildWorld({ logRecords: [runningRecord()] });
    let lost = false;
    const responseLostFetch: typeof fetch = async (request, init) => {
      const response = await world.mock.fetch(request, init);
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url);
      if (!lost && init?.method === "PUT" && url.pathname.endsWith("/records.json")) {
        lost = true;
        throw new TypeError("PUT response lost");
      }
      return response;
    };
    const output: Record<string, unknown>[] = [];
    expect(await forceUnlockJobCommand(world.profile, input, {
      baseFetch: responseLostFetch, now: () => NOW, writeJson: (value) => output.push(value),
    })).toBe(0);
    expect(output[0]).toMatchObject({ outcome: "RELEASED" });
    expect(logRecords(world)[0]).toMatchObject({ status: "FAILED", job_key: "", job_key_done: JOB_KEY });
  });

  test("UPDATE 応答消失後の再 GET 不能は UNCONFIRMED / Exit 3 + nextAction", async () => {
    world = buildWorld({ logRecords: [runningRecord()] });
    let updateApplied = false;
    const unconfirmedFetch: typeof fetch = async (request, init) => {
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url);
      if (updateApplied && (init?.method ?? "GET") === "GET" && url.pathname.endsWith("/records.json")) {
        throw new TypeError("confirmation GET lost");
      }
      const response = await world.mock.fetch(request, init);
      if (!updateApplied && init?.method === "PUT" && url.pathname.endsWith("/records.json")) {
        updateApplied = true;
        throw new TypeError("PUT response lost");
      }
      return response;
    };
    const output: Record<string, unknown>[] = [];
    expect(await forceUnlockJobCommand(world.profile, input, {
      baseFetch: unconfirmedFetch, now: () => NOW, writeJson: (value) => output.push(value),
    })).toBe(3);
    expect(output[0]).toMatchObject({ outcome: "UNCONFIRMED" });
    expect(String(output[0].nextAction)).toContain("inspect-lock");
  });
});
