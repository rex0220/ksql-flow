import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCommand } from "../../src/commands/run";
import { runAllCommand } from "../../src/commands/runAll";
import { LockedError } from "../../src/errors";
import { LocalLock } from "../../src/lock";
import { StateStore } from "../../src/state";
import { EXIT } from "../../src/types";
import { AS_OF, buildWorld, LOG_APP, logRecords, SAMPLE_JOB, TestWorld, writeJob } from "../helpers/world";

describe("v0.6 --resume-batch", () => {
  let world: TestWorld;

  afterEach(() => world?.cleanup());

  test("指定した古い BATCH のみを再開し、より新しい BATCH の影響を受けない", async () => {
    world = buildWorld({
      logRecords: [
        batch("target-batch", "test", "FAILED", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
        job("target-batch", "FAILED"),
        batch("newer-batch", "test", "SUCCESS", "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z"),
        job("newer-batch", "SUCCESS"),
      ],
    });
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);

    const code = await runAllCommand(world.profile, world.jobsDir, {
      resumeBatch: "target-batch",
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("2026-08-01T00:00:00.000Z");
    const batches = logRecords(world).filter((record) => record.record_type === "BATCH");
    expect(batches).toHaveLength(3);
    const resumedBatch = batches[2];
    expect(resumedBatch.as_of).toBe("2026-08-01T00:00:00Z");
    expect(logRecords(world).some(
      (record) => record.record_type === "JOB" && record.parent_batch_id === resumedBatch.batch_id
    )).toBe(true);
  });

  test("JOB 選抜も指定 BATCH 配下だけを参照し、他 BATCH の失敗を混ぜない", async () => {
    world = buildWorld({
      logRecords: [
        batch("target-success", "test", "SUCCESS", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"),
        job("target-success", "SUCCESS"),
        batch("other-failed", "test", "FAILED", "2026-08-02T00:00:00Z", "2026-08-02T00:00:00Z"),
        job("other-failed", "FAILED"),
      ],
    });
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);

    expect(await runAllCommand(world.profile, world.jobsDir, {
      resumeBatch: "target-success",
      baseFetch: world.mock.fetch,
      out: world.out,
    })).toBe(EXIT.OK);

    expect(world.output.join("\n")).toContain("再実行が必要なジョブはありません");
    expect(logRecords(world).filter((record) => record.record_type === "BATCH")).toHaveLength(2);
  });

  test.each([
    ["0 件", [], "missing-batch"],
    ["複数件", [batch("duplicate", "test", "FAILED"), batch("duplicate", "test", "FAILED")], "duplicate"],
    ["profile 不一致", [batch("other-profile", "prod", "FAILED")], "other-profile"],
  ])("BATCH が%sなら Exit 1", async (_case, records, batchId) => {
    world = buildWorld({ logRecords: records });
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      resumeBatch: batchId,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(logRecords(world).filter((record) => record.record_type === "JOB")).toHaveLength(0);
  });

  test("--resume との併用は API 呼び出し前に Exit 1", async () => {
    world = buildWorld();
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    let calls = 0;
    const counted: typeof fetch = async (input, init) => {
      calls += 1;
      return world.mock.fetch(input, init);
    };
    expect(await runAllCommand(world.profile, world.jobsDir, {
      resume: true,
      resumeBatch: "target",
      baseFetch: counted,
      out: world.out,
    })).toBe(EXIT.VALIDATION);
    expect(calls).toBe(0);
  });

  test("logApp 未設定では --lock local-only や state があっても Exit 1", async () => {
    world = buildWorld({ withLogApp: false });
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    new StateStore(world.dir, "test").write({
      schemaVersion: 1,
      profile: "test",
      batchId: "unrelated-local-state",
      asOf: AS_OF,
      startedAt: AS_OF,
      jobs: {},
    });
    expect(await runAllCommand(world.profile, world.jobsDir, {
      resumeBatch: "target",
      lockLocalOnly: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    })).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("state.json へのフォールバックは行いません");
  });

  test("BATCH の as_of が不正な応答は state へフォールバックせず Exit 3", async () => {
    world = buildWorld({ logRecords: [batch("bad-response", "test", "FAILED", "not-a-date")] });
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    expect(await runAllCommand(world.profile, world.jobsDir, {
      resumeBatch: "bad-response",
      baseFetch: world.mock.fetch,
      out: world.out,
    })).toBe(EXIT.RUNTIME);
    expect(logRecords(world).filter((record) => record.record_type === "BATCH")).toHaveLength(1);
  });

  test("ログアプリ GET 失敗時は state.json にフォールバックせず Exit 3", async () => {
    world = buildWorld({ logRecords: [batch("target", "test", "FAILED")] });
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    new StateStore(world.dir, "test").write({
      schemaVersion: 1,
      profile: "test",
      batchId: "unrelated-local-state",
      asOf: AS_OF,
      startedAt: AS_OF,
      jobs: { monthly_sales_sync: { fileName: "01_monthly.sql", status: "FAILED" } },
    });
    const original = world.mock.fetch;
    const gated: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`app=${LOG_APP}`)) {
        return new Response(JSON.stringify({ code: "GAIA", message: "log app down" }), { status: 503 });
      }
      return original(input, init);
    };

    const code = await runAllCommand(world.profile, world.jobsDir, {
      resumeBatch: "target",
      baseFetch: gated,
      out: world.out,
    });

    expect(code).toBe(EXIT.RUNTIME);
    expect(world.output.join("\n")).not.toContain("profile 別 state");
    expect(logRecords(world).filter((record) => record.record_type === "BATCH")).toHaveLength(1);
  });
});

describe("v0.6 KSQL_HOST_LABEL", () => {
  let world: TestWorld;
  const originalLabel = process.env.KSQL_HOST_LABEL;

  afterEach(() => {
    if (originalLabel === undefined) delete process.env.KSQL_HOST_LABEL;
    else process.env.KSQL_HOST_LABEL = originalLabel;
    world?.cleanup();
  });

  test("BATCH/JOB の host だけをラベルで上書きする", async () => {
    process.env.KSQL_HOST_LABEL = "gcp:ksql-flow-demo";
    world = buildWorld();
    writeJob(world, "01_monthly.sql", SAMPLE_JOB);

    expect(await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    })).toBe(EXIT.OK);

    const records = logRecords(world);
    expect(records.filter((record) => record.record_type === "BATCH" || record.record_type === "JOB"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ record_type: "BATCH", host: "gcp:ksql-flow-demo" }),
        expect.objectContaining({ record_type: "JOB", host: "gcp:ksql-flow-demo" }),
      ]));
  });

  test("ラベル設定下でもローカルロックは実ホスト名を記録し、同一ホストの生存 PID を回収しない", () => {
    process.env.KSQL_HOST_LABEL = "vps:vm-xxxx";
    world = buildWorld();
    const first = new LocalLock(world.dir, world.profile.name);
    first.acquire("batch-a", 0);
    expect(first.read()?.host).toBe(os.hostname());

    const second = new LocalLock(world.dir, world.profile.name);
    expect(() => second.acquire("batch-b", 0)).toThrow(LockedError);
    first.release();
  });

  test.each(["", "has space", "slash/value", "あ", "a".repeat(65)])("不正ラベル %p は Exit 1・API 呼び出し 0", async (label) => {
    process.env.KSQL_HOST_LABEL = label;
    world = buildWorld();
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    let calls = 0;
    const counted: typeof fetch = async (input, init) => {
      calls += 1;
      return world.mock.fetch(input, init);
    };

    expect(await runCommand(world.profile, file, { baseFetch: counted, out: world.out })).toBe(EXIT.VALIDATION);
    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(world.dir, ".ksql", "lock-test.json"))).toBe(false);
  });
});

function batch(
  batchId: string,
  profile: string,
  status: string,
  asOf = "2026-08-01T00:00:00Z",
  startedAt = "2026-08-01T00:00:00Z"
): Record<string, string> {
  return { record_type: "BATCH", batch_id: batchId, profile, status, as_of: asOf, started_at: startedAt };
}

function job(parentBatchId: string, status: string): Record<string, string> {
  return {
    record_type: "JOB",
    batch_id: `${parentBatchId}-job`,
    parent_batch_id: parentBatchId,
    profile: "test",
    script_name: "01_monthly.sql",
    status,
    log_detail: "",
  };
}
