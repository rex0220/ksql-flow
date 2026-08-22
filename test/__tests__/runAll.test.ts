import { aggregateExit, runAllCommand } from "../../src/commands/runAll";
import { EXIT, JobOutcome, JobStatus } from "../../src/types";
import { LOG_APP, AS_OF, buildWorld, logRecords, TestWorld, writeJob } from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

const ORDERS = [
  { 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" },
];

const JOB_A = `-- @ksql name: job_a
-- @ksql dialect: 1
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績)
SELECT 顧客コード, SUM(金額) FROM LAPP_受注 GROUP BY 顧客コード
KEY (顧客コード);
`;

const JOB_B_DEPENDS_A = `-- @ksql name: job_b
-- @ksql depends_on: job_a
-- @ksql dialect: 1
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数)
SELECT 顧客コード, COUNT(レコード番号) FROM LAPP_受注 GROUP BY 顧客コード
KEY (顧客コード);
`;

const JOB_C_INDEPENDENT = `-- @ksql name: job_c
-- @ksql dialect: 1
SELECT COUNT(*) FROM LAPP_受注;
`;

const JOB_FAIL = `-- @ksql name: job_a
-- @ksql dialect: 1
ASSERT (SELECT COUNT(*) FROM LAPP_受注) = 0, '意図的な ASSERT 失敗';
`;

const JOB_A_TIMEOUT = `-- @ksql name: job_a
-- @ksql timeout: 1
-- @ksql dialect: 1
SELECT COUNT(*) FROM LAPP_受注;
`;

describe("run-all（設計書 4 章 / 10.3）", () => {
  test("logApp 未設定は既定で Exit 1、--lock local-only 明示時だけ続行する", async () => {
    world = buildWorld({ orders: ORDERS, withLogApp: false });
    writeJob(world, "01_a.sql", JOB_A);
    const blocked = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(blocked).toBe(EXIT.VALIDATION);
    expect(world.mock.app(200).records).toHaveLength(0);

    const allowed = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      lockLocalOnly: true,
    });
    expect(allowed).toBe(EXIT.OK);
    expect(world.output.join("\n")).toMatch(/logApp が未設定.*local-only/s);
    expect(world.mock.app(200).records).toHaveLength(1);
  });

  test("全ジョブ成功 → Exit 0・BATCH/JOB レコードが親子で残る", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_A);
    writeJob(world, "02_b.sql", JOB_B_DEPENDS_A);
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const logs = logRecords(world);
    const batch = logs.find((row) => row.record_type === "BATCH");
    expect(batch).toBeDefined();
    expect(batch!.status).toBe("SUCCESS");
    expect(batch!.job_key).toBe(""); // バッチロックもクリア
    expect(batch!.job_key_done).toBe("test:__batch__");
    const jobs = logs.filter((row) => row.record_type === "JOB");
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.parent_batch_id).toBe(batch!.batch_id);
      expect(job.status).toBe("SUCCESS");
    }
  });

  test("依存先の失敗 → 依存ジョブのみ SKIPPED・独立ジョブは実行される（既定）", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_FAIL); // job_a が ABORTED
    writeJob(world, "02_b.sql", JOB_B_DEPENDS_A); // job_a に依存 → SKIPPED
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT); // 独立 → 実行
    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.ABORTED); // 集約: 3 > 2 > 5 > 1 で 2
    const logs = logRecords(world);
    const byScript = new Map(logs.filter((r) => r.record_type === "JOB").map((r) => [r.script_name, r]));
    expect(byScript.get("01_a.sql")!.status).toBe("ABORTED");
    expect(byScript.get("02_b.sql")!.status).toBe("SKIPPED");
    expect(byScript.get("02_b.sql")!.log_detail).toContain("dependency: job_a");
    expect(byScript.get("03_c.sql")!.status).toBe("SUCCESS");
  });

  test("--stop-on-error は失敗以降を全てスキップする", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_FAIL);
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      stopOnError: true,
    });
    expect(code).toBe(EXIT.ABORTED);
    const logs = logRecords(world);
    const byScript = new Map(logs.filter((r) => r.record_type === "JOB").map((r) => [r.script_name, r]));
    expect(byScript.get("03_c.sql")!.status).toBe("SKIPPED");
    expect(byScript.get("03_c.sql")!.log_detail).toContain("stop-on-error");
  });

  test("--continue-on-error で成功と失敗が混在 → Exit 4", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_FAIL);
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      continueOnError: true,
    });
    expect(code).toBe(EXIT.PARTIAL);
  });

  test("バッチロック競合（別 run-all が RUNNING）→ 何も実行せず Exit 5", async () => {
    world = buildWorld({
      orders: ORDERS,
      logRecords: [
        {
          record_type: "BATCH",
          status: "RUNNING",
          job_key: "test:__batch__",
          batch_id: "other-batch",
          profile: "test",
          started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        },
      ],
    });
    writeJob(world, "01_a.sql", JOB_A);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.LOCKED);
    // JOB レコードは作られていない
    expect(logRecords(world).filter((r) => r.record_type === "JOB")).toHaveLength(0);
  });

  test("LOCKED の依存元は SKIPPED となり依存先へ停止伝播する", async () => {
    world = buildWorld({
      orders: ORDERS,
      logRecords: [{
        record_type: "JOB",
        status: "RUNNING",
        job_key: "test:job_a",
        batch_id: "other-batch",
        profile: "test",
        script_name: "01_a.sql",
        started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }],
    });
    writeJob(world, "01_a.sql", JOB_A);
    writeJob(world, "02_b.sql", JOB_B_DEPENDS_A);

    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.LOCKED);
    const logs = logRecords(world);
    const batch = logs.find((row) => row.record_type === "BATCH" && row.batch_id !== "other-batch");
    const dependent = logs.find(
      (row) => row.record_type === "JOB" && row.parent_batch_id === batch?.batch_id && row.script_name === "02_b.sql"
    );
    expect(dependent?.status).toBe("SKIPPED");
    expect(dependent?.log_detail).toContain("dependency: job_a");
    expect(world.output.join("\n")).toContain("ロック競合");
  });

  test("TIMEOUT の依存元から依存先へ SKIPPED が伝播する", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_A_TIMEOUT);
    writeJob(world, "02_b.sql", JOB_B_DEPENDS_A);
    const original = world.mock.fetch;
    const slow: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      const isLogApp = url.includes("app=999") || body.includes('"app":999');
      if (!isLogApp) await new Promise((resolve) => setTimeout(resolve, 1200));
      return original(input, init);
    };

    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: slow,
      out: world.out,
    });

    expect(code).toBe(EXIT.RUNTIME);
    const jobs = logRecords(world).filter((row) => row.record_type === "JOB");
    expect(jobs.find((row) => row.script_name === "01_a.sql")?.status).toBe("TIMEOUT");
    const dependent = jobs.find((row) => row.script_name === "02_b.sql");
    expect(dependent?.status).toBe("SKIPPED");
    expect(dependent?.log_detail).toContain("dependency: job_a");
  });
});

describe("--resume（受入基準 4: 失敗ジョブのみを元の as-of で再実行）", () => {
  test("--only は選抜外を SKIPPED (filtered) で記録し、直後の resume では再実行しない", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_A);
    writeJob(world, "02_b.sql", JOB_B_DEPENDS_A);
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT);

    const first = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      only: "01_a.sql",
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(first).toBe(EXIT.OK);

    const firstLogs = logRecords(world);
    const batch = firstLogs.find((row) => row.record_type === "BATCH")!;
    const jobs = firstLogs.filter((row) => row.record_type === "JOB" && row.parent_batch_id === batch.batch_id);
    expect(jobs).toHaveLength(3);
    expect(jobs.find((row) => row.script_name === "01_a.sql")?.status).toBe("SUCCESS");
    for (const filtered of jobs.filter((row) => row.script_name !== "01_a.sql")) {
      expect(filtered.status).toBe("SKIPPED");
      expect(filtered.log_detail).toBe("SKIPPED (filtered)");
      expect(filtered.job_key).toBeUndefined();
    }

    const second = await runAllCommand(world.profile, world.jobsDir, {
      resume: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(second).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("再実行が必要なジョブはありません");
    expect(logRecords(world).filter((row) => row.record_type === "BATCH")).toHaveLength(1);
  });

  test("filtered ジョブは onFailure 通知の失敗ジョブ一覧に含めない", async () => {
    world = buildWorld({
      orders: ORDERS,
      profilePatch: { notifications: { onFailure: { webhook: "https://hooks.example.com/failure" } } },
    });
    writeJob(world, "01_a.sql", JOB_FAIL);
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT);
    let payload: { jobs?: Array<{ script: string }> } | undefined;
    const notifyFetch: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as { jobs?: Array<{ script: string }> };
      return new Response("{}", { status: 200 });
    };

    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      only: "01_a.sql",
      baseFetch: world.mock.fetch,
      notifyFetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.ABORTED);
    expect(payload?.jobs?.map((job) => job.script)).toEqual(["01_a.sql"]);
  });

  test("run-all の heartbeat on: always は ABORTED 時も onFailure と併送する", async () => {
    world = buildWorld({ orders: ORDERS });
    world.profile.notifications = {
      onFailure: { webhook: "https://hooks.example.com/failure" },
      heartbeat: { url: "https://hooks.example.com/heartbeat", on: "always" },
    };
    writeJob(world, "01_a.sql", JOB_FAIL);
    const calls: Array<{ url: string; body: { status?: string } }> = [];
    const notifyFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as { status?: string },
      });
      return new Response("{}", { status: 200 });
    };

    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      notifyFetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.ABORTED);
    expect(calls.map((call) => call.url)).toEqual([
      "https://hooks.example.com/failure",
      "https://hooks.example.com/heartbeat",
    ]);
    expect(calls[1].body.status).toBe("ABORTED");
  });

  test("直近 BATCH に JOB レコードが 0 件なら全ジョブを未着手として再実行する", async () => {
    world = buildWorld({
      orders: ORDERS,
      logRecords: [{
        record_type: "BATCH",
        status: "RUNNING",
        job_key: "test:__batch__",
        batch_id: "crashed-batch",
        profile: "test",
        as_of: "2026-07-31T15:00:00Z",
        started_at: toOldKintoneDateTime(),
      }],
    });
    writeJob(world, "01_a.sql", JOB_A);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      resume: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.mock.app(200).records).toHaveLength(1);
    const jobs = logRecords(world).filter((record) => record.record_type === "JOB");
    expect(jobs.map((job) => job.script_name)).toEqual(["01_a.sql"]);
  });

  test("直近バッチの FAILED/SKIPPED のみ再実行し、as-of を引き継ぐ", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_FAIL); // 1 回目は失敗させる
    writeJob(world, "02_b.sql", JOB_B_DEPENDS_A);
    writeJob(world, "03_c.sql", JOB_C_INDEPENDENT);

    const originalAsOf = "2026-08-01T00:00:00+09:00";
    const first = await runAllCommand(world.profile, world.jobsDir, {
      asOf: originalAsOf,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(first).toBe(EXIT.ABORTED);

    // ジョブを修正して resume（as-of は指定しない）
    writeJob(world, "01_a.sql", JOB_A);
    const second = await runAllCommand(world.profile, world.jobsDir, {
      baseFetch: world.mock.fetch,
      out: world.out,
      resume: true,
    });
    expect(second).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("as-of を引き継ぎます");

    const logs = logRecords(world);
    const batches = logs.filter((r) => r.record_type === "BATCH");
    expect(batches).toHaveLength(2);
    // resume バッチの as_of が元バッチと同一（2026-08-01T00:00 JST = 07-31T15:00Z）
    expect(batches[1].as_of).toBe(batches[0].as_of);
    expect(batches[1].as_of).toBe("2026-07-31T15:00:00Z");

    // 再実行されたのは job_a（失敗）と job_b（SKIPPED）のみ。job_c は成功済みなので再実行されない
    const resumeJobs = logs.filter(
      (r) => r.record_type === "JOB" && r.parent_batch_id === batches[1].batch_id
    );
    const scripts = resumeJobs.map((r) => r.script_name).sort();
    expect(scripts).toEqual(["01_a.sql", "02_b.sql"]);
    for (const job of resumeJobs) {
      expect(job.status).toBe("SUCCESS");
      expect(job.as_of).toBe("2026-07-31T15:00:00Z");
    }
  });

  test("ログアプリ到達不能時は profile 別 state フォールバック（警告付き）", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_a.sql", JOB_FAIL);
    const originalAsOf = "2026-08-01T00:00:00+09:00";
    const first = await runAllCommand(world.profile, world.jobsDir, {
      asOf: originalAsOf,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(first).toBe(EXIT.ABORTED);

    // 2 回目はログアプリを落として resume → profile 別 state フォールバック + fail-closed 到達前に
    // ロック確立不能になるため --lock local-only を併用
    writeJob(world, "01_a.sql", JOB_A);
    const original = world.mock.fetch;
    const gated: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("app=999") || body.includes(`"app":999`) || url.includes(`app=${LOG_APP}`)) {
        return new Response(JSON.stringify({ code: "GAIA", message: "log app down" }), { status: 503 });
      }
      return original(input, init);
    };
    const second = await runAllCommand(world.profile, world.jobsDir, {
      baseFetch: gated,
      out: world.out,
      resume: true,
      lockLocalOnly: true,
    });
    expect(second).toBe(EXIT.OK);
    const text = world.output.join("\n");
    expect(text).toContain("profile 別 state");
    expect(text).toContain("as-of を引き継ぎます");
  });
});

function toOldKintoneDateTime(): string {
  return new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("Exit Code 集約（受入基準 6: 10.3 の全ケース）", () => {
  const outcome = (status: JobStatus, exitCode: number, skipReason?: string): JobOutcome => ({
    jobName: "x",
    scriptName: "x.sql",
    status,
    exitCode: exitCode as JobOutcome["exitCode"],
    skipReason,
    readCount: 0,
    writtenCount: 0,
    apiCalls: 0,
    detailLines: [],
  });

  test("全て SUCCESS / NO_DATA → 0", () => {
    expect(aggregateExit([outcome("SUCCESS", 0), outcome("NO_DATA", 0)], false)).toBe(0);
    expect(aggregateExit([outcome("NO_DATA", 0)], true)).toBe(0);
  });

  test("失敗のみ → 最重大コード（3 > 2 > 5 > 1）", () => {
    expect(aggregateExit([outcome("FAILED", 1), outcome("FAILED", 3)], false)).toBe(3);
    expect(aggregateExit([outcome("ABORTED", 2), outcome("FAILED", 1)], false)).toBe(2);
    expect(aggregateExit([outcome("SKIPPED", 0, "LOCKED"), outcome("FAILED", 1)], false)).toBe(5);
    expect(aggregateExit([outcome("FAILED", 1)], false)).toBe(1);
    expect(aggregateExit([outcome("FAILED", 3), outcome("ABORTED", 2), outcome("SKIPPED", 0, "LOCKED")], false)).toBe(3);
    expect(aggregateExit([outcome("TIMEOUT", 3), outcome("ABORTED", 2)], false)).toBe(3);
  });

  test("continue-on-error で成功と失敗の混在 → 4", () => {
    expect(aggregateExit([outcome("SUCCESS", 0), outcome("FAILED", 3)], true)).toBe(4);
    expect(aggregateExit([outcome("NO_DATA", 0), outcome("ABORTED", 2)], true)).toBe(4);
  });

  test("continue-on-error でも失敗のみなら最重大コード", () => {
    expect(aggregateExit([outcome("FAILED", 3), outcome("FAILED", 1)], true)).toBe(3);
  });

  test("既定モードで成功と失敗の混在 → 最重大コード（4 にはならない）", () => {
    expect(aggregateExit([outcome("SUCCESS", 0), outcome("FAILED", 3)], false)).toBe(3);
    expect(aggregateExit([outcome("SUCCESS", 0), outcome("SKIPPED", 0, "LOCKED")], false)).toBe(5);
  });

  test("依存スキップ（LOCKED 以外）は集約対象外", () => {
    expect(aggregateExit([outcome("SUCCESS", 0), outcome("SKIPPED", 0, "dependency: a")], false)).toBe(0);
  });
});
