import * as fs from "fs";
import * as path from "path";
import { runCommand } from "../../src/commands/run";
import { unlockCommand } from "../../src/commands/unlock";
import { EXIT } from "../../src/types";
import { toKintoneDateTime } from "../../src/logapp";
import { LocalLock } from "../../src/lock";
import {
  AS_OF,
  buildWorld,
  LOG_APP,
  logRecords,
  SAMPLE_JOB,
  TestWorld,
  writeJob,
} from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

const ORDERS = [{ 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }];

describe("排他ロック（受入基準 3）", () => {
  test("同一プロファイルの二重起動は Exit 5・終了後は job_key がクリアされ翌実行が通る", async () => {
    world = buildWorld({
      orders: ORDERS,
      logRecords: [
        {
          record_type: "JOB",
          status: "RUNNING",
          job_key: "test:monthly_sales_sync",
          batch_id: "other-host-batch",
          script_name: "01_monthly.sql",
          profile: "test",
          started_at: toKintoneDateTime(new Date()),
        },
      ],
    });
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    // 1 回目: 別ホストの RUNNING レコードが残っている → Exit 5
    const locked = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(locked).toBe(EXIT.LOCKED);
    expect(world.output.join("\n")).toContain("多重起動");

    // 前回分が終了（job_key クリア）していれば通る
    const running = world.mock.app(LOG_APP).records[0];
    running.values.job_key = "";
    running.values.job_key_done = "test:monthly_sales_sync";
    running.values.status = "SUCCESS";

    const ok = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(ok).toBe(EXIT.OK);
    const logs = logRecords(world);
    expect(logs).toHaveLength(2);
    expect(logs[1].status).toBe("SUCCESS");
    expect(logs[1].job_key).toBe("");
    expect(logs[1].job_key_done).toBe("test:monthly_sales_sync");
  });

  test("stale ロック（batchTimeoutSec 超過）は自動回収され実行が通る", async () => {
    const staleStarted = new Date(Date.now() - 2 * 3600 * 1000); // 2 時間前
    world = buildWorld({
      orders: ORDERS,
      logRecords: [
        {
          record_type: "JOB",
          status: "RUNNING",
          job_key: "test:monthly_sales_sync",
          batch_id: "stale-batch",
          script_name: "01_monthly.sql",
          profile: "test",
          started_at: toKintoneDateTime(staleStarted),
        },
      ],
    });
    world.profile.limits.batchTimeoutSec = 3600; // 1 時間
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    world.profile.limits.batchTimeoutSec = 1;
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const logs = logRecords(world);
    // stale レコードは TIMEOUT へ回収済み（設計書 5.5: クリア時に status を TIMEOUT へ）
    expect(logs[0].status).toBe("TIMEOUT");
    expect(logs[0].job_key).toBe("");
    expect(logs[0].job_key_done).toBe("test:monthly_sales_sync");
    expect(logs[0].log_detail).toContain("自動回収");
    expect(logs[1].status).toBe("SUCCESS");
  });

  test("ローカルロックが残っていて相手プロセスが生存中なら Exit 5", async () => {
    world = buildWorld({ orders: ORDERS });
    const lockDir = path.join(world.dir, ".ksql");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "lock-test.json"),
      JSON.stringify({
        pid: process.pid, // 自プロセス = 生存中とみなされる
        host: require("os").hostname(),
        profile: "test",
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        batchId: "other",
      })
    );
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.LOCKED);
  });

  test("force-unlock 後の旧所有者 release は新所有者のロックを削除しない", () => {
    world = buildWorld();
    const first = new LocalLock(world.dir, world.profile.name);
    const second = new LocalLock(world.dir, world.profile.name);
    first.acquire("batch-a", 3600);
    expect(first.forceRelease()).toBe(true);
    second.acquire("batch-b", 3600);
    first.release();
    expect(second.read()?.batchId).toBe("batch-b");
    second.release();
  });

  test("unlock コマンドがローカルロックと RUNNING レコードを解除する", async () => {
    world = buildWorld({
      logRecords: [
        {
          record_type: "JOB",
          status: "RUNNING",
          job_key: "test:hung_job",
          batch_id: "hung-batch",
          script_name: "01_hung.sql",
          profile: "test",
          started_at: toKintoneDateTime(new Date()),
        },
      ],
    });
    const lockDir = path.join(world.dir, ".ksql");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "lock-test.json"),
      JSON.stringify({ pid: 999999, host: "other", profile: "test", startedAt: new Date().toISOString(), batchId: "x" })
    );
    const code = await unlockCommand(world.profile, { baseFetch: world.mock.fetch, out: world.out });
    expect(code).toBe(EXIT.OK);
    expect(fs.existsSync(path.join(lockDir, "lock-test.json"))).toBe(false);
    const logs = logRecords(world);
    expect(logs[0].status).toBe("TIMEOUT");
    expect(logs[0].job_key).toBe("");
    expect(logs[0].log_detail).toContain("unlock による明示解除");
  });
});

describe("fail-closed とローカルフォールバック（受入基準 5）", () => {
  test("logApp 未設定は既定で Exit 1・業務書込 0 件", async () => {
    world = buildWorld({ orders: ORDERS, withLogApp: false });
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("logApp が未設定");
    expect(world.mock.app(200).records).toHaveLength(0);
  });

  test("logApp 未設定でも --lock local-only 明示時だけ警告付きで続行する", async () => {
    world = buildWorld({ orders: ORDERS, withLogApp: false });
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      lockLocalOnly: true,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toMatch(/logApp が未設定.*local-only/s);
    expect(world.mock.app(200).records).toHaveLength(1);
  });

  test("開始時にログアプリ到達不能 → fail-closed (Exit 3)・何も書き込まない", async () => {
    world = buildWorld({ orders: ORDERS });
    // ログアプリ (app=999) 宛のリクエストのみ失敗させる
    const original = world.mock.fetch;
    const gated: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("app=999") || body.includes('"app":999')) {
        return new Response(JSON.stringify({ code: "GAIA", message: "log app unavailable" }), { status: 503 });
      }
      return original(input, init);
    };
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: gated,
      out: world.out,
    });
    expect(code).toBe(EXIT.RUNTIME);
    expect(world.output.join("\n")).toContain("fail-closed");
    // 業務アプリには何も書き込まれていない
    expect(world.mock.app(200).records).toHaveLength(0);
    expect(logRecords(world)).toHaveLength(0);
  });

  test("ロック INSERT の一般的な HTTP 400 は多重起動でなく Exit 3", async () => {
    world = buildWorld({ orders: ORDERS });
    const original = world.mock.fetch;
    const invalidLogInsert: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { app?: number; records?: unknown[] } : {};
      if ((init?.method ?? "GET") === "POST" && body.app === LOG_APP) {
        return new Response(JSON.stringify({ code: "CB_VA01", message: "invalid field" }), { status: 400 });
      }
      return original(input, init);
    };
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: invalidLogInsert,
      out: world.out,
    });
    expect(code).toBe(EXIT.RUNTIME);
    expect(code).not.toBe(EXIT.LOCKED);
    expect(world.mock.app(200).records).toHaveLength(0);
  });

  test("--lock local-only なら警告付きで続行できる（設計書 5.5-4 の明示緩和）", async () => {
    world = buildWorld({ orders: ORDERS });
    const original = world.mock.fetch;
    const gated: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.includes("app=999") || body.includes('"app":999')) {
        return new Response(JSON.stringify({ code: "GAIA", message: "log app unavailable" }), { status: 503 });
      }
      return original(input, init);
    };
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: gated,
      out: world.out,
      lockLocalOnly: true,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("local-only");
    // 業務処理は完了している
    expect(world.mock.app(200).records).toHaveLength(1);
  });

  test("実行中のログ書込失敗はローカル JSONL + 再送キューに退避され、次回実行時に再送される", async () => {
    world = buildWorld({ orders: ORDERS });
    // 終了時の PUT（ログアプリ更新）だけを失敗させる
    world.mock.failNext({
      times: 2, // maxAttempts=2 の両試行
      status: 503,
      match: (method, p) => method === "PUT" && p.endsWith("/records.json"),
    });
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK); // ログ書込失敗はジョブ結果に影響しない
    // ログアプリのレコードは RUNNING のまま（終了更新が失敗した）
    let logs = logRecords(world);
    expect(logs[0].status).toBe("RUNNING");
    // JSONL に記録されている
    const jsonlDir = world.profile.logging.localDir;
    const jsonlFiles = fs.readdirSync(jsonlDir).filter((f) => f.endsWith(".jsonl"));
    expect(jsonlFiles.length).toBeGreaterThan(0);
    const jsonl = fs.readFileSync(path.join(jsonlDir, jsonlFiles[0]), "utf8");
    expect(jsonl).toContain("logapp_write_failed");
    // 再送キューに積まれている
    const pendingDir = path.join(jsonlDir, "pending");
    expect(fs.readdirSync(pendingDir).length).toBe(1);

    // 次回実行: 分散ロック取得の前に再送が走り、前回の終了更新（job_key クリア）が適用されるため
    // ロック衝突にはならず、そのまま実行できる
    const second = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(second).toBe(EXIT.OK);
    expect(fs.readdirSync(pendingDir).length).toBe(0); // 再送済み
    logs = logRecords(world);
    // 再送により最初のレコードの終了更新が適用されている
    expect(logs[0].status).toBe("SUCCESS");
    expect(logs[0].job_key).toBe("");
    expect(logs[0].job_key_done).toBe("test:monthly_sales_sync");
    expect(logs[1].status).toBe("SUCCESS"); // 2 回目の実行分
  });
});
