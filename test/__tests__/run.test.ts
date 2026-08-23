import * as fs from "fs";
import * as path from "path";
import { runCommand } from "../../src/commands/run";
import { EXIT } from "../../src/types";
import {
  AS_OF,
  buildWorld,
  customerRecords,
  logRecords,
  SAMPLE_JOB,
  CUSTOMER_APP,
  TestWorld,
  writeJob,
} from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

function notifyCapture(): { calls: Array<{ url: string; body: unknown }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls, fetch: impl };
}

describe("run（受入基準 1: サンプルジョブ実行とログアプリ記録）", () => {
  test("正常実行: UPSERT が反映され JOB レコードが SUCCESS で残る", async () => {
    world = buildWorld({
      withDeletedCount: true,
      orders: [
        { 顧客コード: "C0012", 金額: "100000", 受注日: "2026-08-05", ステータス: "受注完了" },
        { 顧客コード: "C0012", 金額: "50000", 受注日: "2026-08-10", ステータス: "受注完了" },
        { 顧客コード: "C0034", 金額: "380000", 受注日: "2026-08-15", ステータス: "受注完了" },
        { 顧客コード: "C0099", 金額: "9999", 受注日: "2026-07-01", ステータス: "受注完了" },
      ],
      customers: [{ 顧客コード: "C0012", 当月売上実績: "0" }],
    });
    const file = writeJob(world, "01_monthly_sales_sync.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(world.output.join("\n")).toContain("SUCCESS");
    expect(code).toBe(EXIT.OK);

    // 顧客マスタへの反映（C0012 更新 / C0034 新規。7 月分の C0099 は対象外）
    const customers = customerRecords(world);
    const c12 = customers.find((row) => row["顧客コード"] === "C0012");
    const c34 = customers.find((row) => row["顧客コード"] === "C0034");
    expect(c12?.["当月売上実績"]).toBe("150000");
    expect(c12?.["当月受注件数"]).toBe("2");
    expect(c34?.["当月売上実績"]).toBe("380000");
    expect(customers.find((row) => row["顧客コード"] === "C0099")).toBeUndefined();

    // ログアプリ JOB レコード（設計書 8.2）
    const logs = logRecords(world);
    expect(logs).toHaveLength(1);
    const job = logs[0];
    expect(job.record_type).toBe("JOB");
    expect(job.status).toBe("SUCCESS");
    expect(job.script_name).toBe("01_monthly_sales_sync.sql");
    expect(job.profile).toBe("test");
    expect(job.job_key).toBe(""); // 終了時にクリア（設計書 5.5）
    expect(job.job_key_done).toBe("test:monthly_sales_sync");
    expect(job.as_of).toBe("2026-08-21T00:00:00Z");
    expect(Number(job.written_count)).toBe(2);
    expect(Number(job.deleted_count)).toBe(0);
    expect(Number(job.api_calls)).toBeGreaterThan(0);
    expect(job.batch_id).not.toBe("");
  });

  test("DELETE は deleted_count に独立集計し written_count にも従来どおり含める", async () => {
    world = buildWorld({
      withDeletedCount: true,
      customers: [
        { 顧客コード: "C1", 当月売上実績: "100" },
        { 顧客コード: "C2", 当月売上実績: "200" },
      ],
    });
    const file = writeJob(world, "01_delete.sql", `-- @ksql dialect: 1
DELETE FROM LAPP_顧客マスタ WHERE 当月売上実績 >= 100;
`);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.OK);
    expect(customerRecords(world)).toHaveLength(0);
    const job = logRecords(world)[0];
    expect(Number(job.written_count)).toBe(2);
    expect(Number(job.deleted_count)).toBe(2);
  });

  test("旧ログアプリでは deleted_count を送らず、フィールド取得と案内は 1 回だけ", async () => {
    world = buildWorld({ customers: [{ 顧客コード: "C1", 当月売上実績: "100" }] });
    const file = writeJob(world, "01_delete_legacy.sql", `-- @ksql dialect: 1
DELETE FROM LAPP_顧客マスタ WHERE 顧客コード = 'C1';
`);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.OK);
    expect(logRecords(world)[0].deleted_count).toBeUndefined();
    const fieldGets = world.mock.requests.filter(
      (request) => request.appId === 999 && request.method === "GET" && request.path.endsWith("/app/form/fields.json")
    );
    expect(fieldGets).toHaveLength(1);
    const logWrites = world.mock.requests.filter(
      (request) => request.appId === 999 && (request.method === "POST" || request.method === "PUT")
    );
    for (const request of logWrites) {
      const serialized = JSON.stringify(request.body);
      expect(serialized).not.toContain("deleted_count");
    }
    expect(world.output.filter((line) => line.includes("ログアプリに deleted_count がありません"))).toHaveLength(1);
  });

  test.each([0, 1, 100, 101])(
    "エンジン実体の書込境界 %i 件: HTTP 書込回数 ceil(N/100) と written_count",
    async (count) => {
      const orders = Array.from({ length: count }, (_, index) => ({
        顧客コード: `C${String(index).padStart(4, "0")}`,
        金額: "100",
        受注日: "2026-08-05",
        ステータス: "受注完了",
      }));
      world = buildWorld({ orders });
      const file = writeJob(world, "01_boundary.sql", SAMPLE_JOB);
      const code = await runCommand(world.profile, file, {
        asOf: AS_OF,
        baseFetch: world.mock.fetch,
        out: world.out,
      });
      expect(code).toBe(EXIT.OK);
      const writes = world.mock.requests.filter((request) =>
        request.appId === CUSTOMER_APP && request.path.endsWith("/records.json") &&
        (request.method === "POST" || request.method === "PUT")
      );
      expect(writes).toHaveLength(Math.ceil(count / 100));
      expect(Number(logRecords(world)[0].written_count)).toBe(count);
    }
  );

  test("v3.70.0 metrics スナップショットから文単位の増分を記録する", async () => {
    world = buildWorld({
      orders: [
        { 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" },
        { 顧客コード: "C2", 金額: "200", 受注日: "2026-08-06", ステータス: "受注完了" },
        { 顧客コード: "C3", 金額: "300", 受注日: "2026-08-07", ステータス: "受注完了" },
      ],
    });
    const source = `-- @ksql dialect: 1
SELECT * FROM LAPP_受注;
SELECT * FROM LAPP_受注 WHERE 顧客コード = 'C1';
`;
    const file = writeJob(world, "01_metrics.sql", source);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);

    const statements = jsonlEvents(world, "statement");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toEqual(expect.objectContaining({ v: 1, batchId: expect.any(String), profile: "test" }));
    expect(statements[0].ts).toEqual(expect.any(String));
    expect(statements.map((event) => event.readCount)).toEqual([3, 1]);
    expect(statements.every((event) => Number(event.apiCalls) > 0)).toBe(true);
    expect(Number(logRecords(world)[0].read_count)).toBe(4);
  });

  test("公開 DML 結果型で UPDATE を含む文単位 written_count を正しく計上する", async () => {
    world = buildWorld({ customers: [{ 顧客コード: "C1", 当月売上実績: "100" }] });
    const file = writeJob(
      world,
      "01_update.sql",
      `-- @ksql dialect: 1
UPDATE LAPP_顧客マスタ SET 当月売上実績 = 200 WHERE 顧客コード = 'C1';
INSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) VALUES ('C2', 300);
`
    );
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(jsonlEvents(world, "statement").map((event) => event.writtenCount)).toEqual([1, 1]);
    expect(Number(logRecords(world)[0].written_count)).toBe(2);
  });

  test("250 件 UPSERT は 3 チャンクを記録し最終 lastKeyValue を JSONL とログアプリへ残す", async () => {
    world = buildWorld({});
    const file = writeJob(world, "01_chunks.sql", upsertValuesJob(250));
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);

    const chunks = jsonlEvents(world, "write_chunk");
    expect(chunks).toHaveLength(3);
    expect(chunks.map((event) => event.records)).toEqual([100, 100, 50]);
    expect(chunks.map((event) => event.lastKeyValue)).toEqual(["C099", "C199", "C249"]);
    expect(logRecords(world)[0].last_written_key).toBe("C249");
    expect(Number(logRecords(world)[0].written_count)).toBe(250);
  });

  test("3 チャンク目の失敗時は最後に成功したチャンクの lastKeyValue を残す", async () => {
    world = buildWorld({});
    const file = writeJob(world, "01_chunk_failure.sql", upsertValuesJob(250));
    let customerWriteAttempts = 0;
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { app?: number }) : {};
      if ((init?.method ?? "GET").toUpperCase() === "POST" && body.app === CUSTOMER_APP) {
        customerWriteAttempts += 1;
        if (customerWriteAttempts >= 3) {
          return new Response(JSON.stringify({ code: "MOCK", message: "third chunk failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return world.mock.fetch(input, init);
    }) as typeof fetch;
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: failingFetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.RUNTIME);

    const chunks = jsonlEvents(world, "write_chunk");
    expect(chunks).toHaveLength(2);
    expect(chunks[1].lastKeyValue).toBe("C199");
    expect(logRecords(world)[0].last_written_key).toBe("C199");
    expect(Number(logRecords(world)[0].written_count)).toBe(200);
    expect(customerRecords(world)).toHaveLength(200);
  });

  test("lastKeyValue は logging.maskFields に指定されたキー列を伏字化する", async () => {
    world = buildWorld({});
    world.profile.logging.maskFields = ["顧客コード"];
    const file = writeJob(world, "01_mask_key.sql", upsertValuesJob(1));
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(jsonlEvents(world, "write_chunk")[0].lastKeyValue).toBe("***");
    expect(logRecords(world)[0].last_written_key).toBe("***");
  });

  test("UPSERT SELECT の lastKeyValue も logging.maskFields で伏字化する", async () => {
    world = buildWorld({
      orders: [
        { 顧客コード: "C0012", 金額: "100000", 受注日: "2026-08-05", ステータス: "受注完了" },
      ],
    });
    world.profile.logging.maskFields = ["顧客コード"];
    const file = writeJob(world, "01_mask_select_key.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(jsonlEvents(world, "write_chunk")[0].lastKeyValue).toBe("***");
    expect(logRecords(world)[0].last_written_key).toBe("***");
  });
});

describe("run（受入基準 2: ABORTED / NO_DATA と通知）", () => {
  test("マイナス売上 → ABORTED (Exit 2)・通知あり", async () => {
    world = buildWorld({
      orders: [{ 顧客コード: "C1", 金額: "-100", 受注日: "2026-08-05", ステータス: "受注完了" }],
    });
    world.profile.notifications = { onFailure: { webhook: "https://hooks.example.com/alert" } };
    const notify = notifyCapture();
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      notifyFetch: notify.fetch,
    });
    expect(code).toBe(EXIT.ABORTED);
    const logs = logRecords(world);
    expect(logs[0].status).toBe("ABORTED");
    expect(logs[0].error_message).toContain("マイナスの売上データ");
    expect(notify.calls).toHaveLength(1);
    expect(notify.calls[0].url).toBe("https://hooks.example.com/alert");
    expect(JSON.stringify(notify.calls[0].body)).toContain("ABORTED");
  });

  test("heartbeat on: success は ABORTED 時に送らず onFailure のみ送る", async () => {
    world = buildWorld({
      orders: [{ 顧客コード: "C1", 金額: "-100", 受注日: "2026-08-05", ステータス: "受注完了" }],
    });
    world.profile.notifications = {
      onFailure: { webhook: "https://hooks.example.com/failure" },
      heartbeat: { url: "https://hooks.example.com/heartbeat", on: "success" },
    };
    const notify = notifyCapture();
    const file = writeJob(world, "01_heartbeat_success.sql", SAMPLE_JOB);

    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      notifyFetch: notify.fetch,
    });

    expect(code).toBe(EXIT.ABORTED);
    expect(notify.calls.map((call) => call.url)).toEqual(["https://hooks.example.com/failure"]);
  });

  test("heartbeat on: always は ABORTED 時も onFailure と併送し status を含める", async () => {
    world = buildWorld({
      orders: [{ 顧客コード: "C1", 金額: "-100", 受注日: "2026-08-05", ステータス: "受注完了" }],
    });
    world.profile.notifications = {
      onFailure: { webhook: "https://hooks.example.com/failure" },
      heartbeat: { url: "https://hooks.example.com/heartbeat", on: "always" },
    };
    const notify = notifyCapture();
    const file = writeJob(world, "01_heartbeat_always.sql", SAMPLE_JOB);

    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      notifyFetch: notify.fetch,
    });

    expect(code).toBe(EXIT.ABORTED);
    expect(notify.calls.map((call) => call.url)).toEqual([
      "https://hooks.example.com/failure",
      "https://hooks.example.com/heartbeat",
    ]);
    expect(notify.calls[1].body).toEqual(expect.objectContaining({ status: "ABORTED" }));
  });

  test("Webhook 非 2xx はマスク済み警告を出しジョブ結果には影響しない", async () => {
    world = buildWorld({
      orders: [{ 顧客コード: "C1", 金額: "-100", 受注日: "2026-08-05", ステータス: "受注完了" }],
    });
    world.profile.notifications = { onFailure: { webhook: "https://hooks.example.com/alert" } };
    const file = writeJob(world, "01_notify_fail.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      notifyFetch: (async () => new Response("secret response", { status: 500 })) as typeof fetch,
    });
    expect(code).toBe(EXIT.ABORTED);
    expect(world.output.join("\n")).toContain("Webhook が HTTP 500");
    expect(world.output.join("\n")).not.toContain("secret response");
  });

  test("対象 0 件 → NO_DATA (Exit 0)・通知なし", async () => {
    world = buildWorld({ orders: [] });
    world.profile.notifications = { onFailure: { webhook: "https://hooks.example.com/alert" } };
    const notify = notifyCapture();
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      notifyFetch: notify.fetch,
    });
    expect(code).toBe(EXIT.OK);
    const logs = logRecords(world);
    expect(logs[0].status).toBe("NO_DATA");
    // onFailure Webhook は呼ばれない（heartbeat 未設定なので通知 0 件）
    expect(notify.calls).toHaveLength(0);
  });

  test("ASSERT WARN は続行し log_detail に記録される", async () => {
    world = buildWorld({
      orders: [{ 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }],
    });
    const source = `-- @ksql name: warn_job
-- @ksql dialect: 1
ASSERT WARN (SELECT COUNT(*) FROM LAPP_受注) = 0, '件数が想定より多い（続行します）';
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績)
SELECT 顧客コード, SUM(金額) FROM LAPP_受注 GROUP BY 顧客コード
KEY (顧客コード);
`;
    const file = writeJob(world, "01_warn.sql", source);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const logs = logRecords(world);
    expect(logs[0].status).toBe("SUCCESS");
    expect(logs[0].log_detail).toContain("ASSERT_WARNING");
  });

  test("検証エラー（未定義フィールド等の実行時 SQL エラー）→ FAILED Exit 1", async () => {
    world = buildWorld({});
    const file = writeJob(world, "01_bad.sql", `-- @ksql dialect: 1\nSELECT * FROM LAPP_未定義アプリ;\n`);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
  });
});

function upsertValuesJob(count: number): string {
  const values = Array.from(
    { length: count },
    (_, index) => `('C${String(index).padStart(3, "0")}', ${index})`
  ).join(",\n");
  return `-- @ksql dialect: 1
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績)
VALUES ${values}
KEY (顧客コード);
`;
}

function jsonlEvents(world: TestWorld, event: string): Array<Record<string, unknown>> {
  const file = fs.readdirSync(world.profile.logging.localDir).find((name) => name.endsWith(".jsonl"));
  if (file === undefined) return [];
  return fs
    .readFileSync(path.join(world.profile.logging.localDir, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}
