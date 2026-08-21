import { runCommand } from "../../src/commands/run";
import { checkLogAppCommand, initLogAppCommand } from "../../src/commands/initLogapp";
import { EXIT } from "../../src/types";
import { AS_OF, buildWorld, customerRecords, LOG_APP, SAMPLE_JOB, TestWorld, writeJob } from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

const ORDERS = [{ 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }];

describe("--dry-run（縮退版: フル検証 + 推定 API 消費。タスク指示書 §4-4）", () => {
  test("検証 OK のジョブ: EXPLAIN 推定を表示し、書き込みは行わない", async () => {
    world = buildWorld({ orders: ORDERS });
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const text = world.output.join("\n");
    expect(text).toContain("[DRY-RUN]");
    expect(text).toContain("estimated API consumption");
    // 書き込みは発生しない
    expect(customerRecords(world)).toHaveLength(0);
    expect(world.mock.requests.every((request) => request.method === "GET" || !request.path.endsWith("/records.json"))).toBe(true);
  });

  test("検証エラーのジョブ: Exit 1 で EXPLAIN まで進まない", async () => {
    world = buildWorld({ customerUnique: false });
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("KSQL1303");
  });

  test("@関数に見える文字列リテラルを置換せず asOf / timezone 付きで EXPLAIN する", async () => {
    world = buildWorld({ orders: ORDERS });
    const file = writeJob(
      world,
      "01_literal.sql",
      `-- @ksql dialect: 1
SELECT '@NOW()' AS marker, @TODAY() AS run_date FROM LAPP_受注;
`
    );
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("[#1] SELECT");
  });
});

describe("init-logapp / --check-logapp（設計書 付録 B）", () => {
  test("init-logapp: password 認証でアプリ作成 → フィールド追加 → デプロイ", async () => {
    world = buildWorld({});
    world.profile.auth = { type: "password", username: "admin", password: "admin-pass" };
    for (const appId of [100, 200, LOG_APP]) world.mock.app(appId).def.expectedToken = undefined;
    const code = await initLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const text = world.output.join("\n");
    expect(text).toContain("デプロイが完了しました");
    // 作成されたアプリに job_key (unique) がある
    const createdId = Math.max(...world.mock.requests
      .filter((request) => request.path.endsWith("/preview/app/form/fields.json"))
      .map((request) => Number((request.body as { app: number }).app)));
    const created = world.mock.app(createdId);
    expect(created.def.fields["job_key"]?.unique).toBe(true);
    expect(created.def.fields["log_detail"]?.type).toBe("MULTI_LINE_TEXT");
  });

  test("init-logapp: apiToken 認証では明確なエラー (Exit 1)", async () => {
    world = buildWorld({});
    const code = await initLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("password");
  });

  test("--check-logapp: 定義が揃っていれば OK", async () => {
    world = buildWorld({});
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("OK");
  });

  test("--check-logapp: job_key の重複禁止がないと NG (Exit 1)", async () => {
    world = buildWorld({});
    world.mock.app(LOG_APP).def.fields["job_key"] = { type: "SINGLE_LINE_TEXT", unique: false };
    delete (world.mock.app(LOG_APP).def.fields as Record<string, unknown>)["last_written_key"];
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    const text = world.output.join("\n");
    expect(text).toContain("重複を禁止");
    expect(text).toContain("last_written_key");
  });
});
