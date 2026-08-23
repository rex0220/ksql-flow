import * as fs from "fs";
import * as path from "path";
import { runCommand } from "../../src/commands/run";
import { EXIT } from "../../src/types";
import { stripSqlLiterals, SecretMasker } from "../../src/logging/mask";
import { AS_OF, buildWorld, logRecords, SAMPLE_JOB, TestWorld, writeJob } from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

const ORDERS = [{ 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }];

describe("上限制御（受入基準 7）", () => {
  test("limits.maxApiCalls 超過で安全停止 (Exit 3)。カウントにログ・ロック分が含まれる", async () => {
    world = buildWorld({ orders: ORDERS });
    // ロック GET(1) + RUNNING INSERT(1) の直後に尽きる値 → 本体実行の最初の API で停止
    world.profile.limits.maxApiCalls = 3;
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.RUNTIME);
    expect(world.output.join("\n")).toContain("maxApiCalls");
    // ロック分 2 回 + 本体 1 回 = 3 回で停止（4 回目は発行されない）
    expect(world.mock.requests.length).toBe(3);
    // ロック操作（ログアプリ GET + POST）がカウントに含まれている
    expect(world.mock.requests[0].appId).toBe(999);
    expect(world.mock.requests[1].appId).toBe(999);
  });

  test("--max-api-calls が config より優先される", async () => {
    world = buildWorld({ orders: ORDERS });
    world.profile.limits.maxApiCalls = 1000;
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      maxApiCalls: 2,
    });
    expect(code).toBe(EXIT.RUNTIME);
    expect(world.mock.requests.length).toBe(2);
  });

  test("十分な上限なら完走し、api_calls がログに記録される", async () => {
    world = buildWorld({ orders: ORDERS });
    world.profile.limits.maxApiCalls = 100;
    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const logs = logRecords(world);
    expect(Number(logs[0].api_calls)).toBeGreaterThan(0);
  });
});

describe("タイムアウト（設計書 7.1 / @ksql timeout）", () => {
  test("timeout 0 秒相当（即時期限切れ）→ TIMEOUT (Exit 3)", async () => {
    world = buildWorld({ orders: ORDERS });
    const source = SAMPLE_JOB.replace("-- @ksql timeout: 600", "-- @ksql timeout: 1");
    const file = writeJob(world, "01_timeout.sql", source);
    // fetch を遅延させて timeout を確実に超過させる
    const original = world.mock.fetch;
    const slow: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      const isLogApp = url.includes("app=999") || body.includes('"app":999');
      if (!isLogApp) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1200);
          (timer as { unref?: () => void }).unref?.();
        });
      }
      return original(input, init);
    };
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: slow,
      out: world.out,
    });
    expect(code).toBe(EXIT.RUNTIME);
    const logs = logRecords(world);
    expect(logs[0].status).toBe("TIMEOUT");
  });
});

describe("秘密情報のマスキング（受入基準 8）", () => {
  test("トークン・パスワードが全出力（コンソール・ログアプリ・JSONL）に現れない", async () => {
    world = buildWorld({ orders: ORDERS });
    world.profile.auth = { type: "password", username: "admin", password: "super-secret-pass" };
    world.profile.notifications = { onFailure: { webhook: "https://hooks.example.com/alert" } };
    // password 認証ではトークンヘッダが送られないため、モックのトークン検査を外す
    for (const appId of [100, 200, 999]) world.mock.app(appId).def.expectedToken = undefined;
    // わざと失敗させる（ログアプリ以外の API を 500 に）
    const original = world.mock.fetch;
    const failing: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      const isLogApp = url.includes("app=999") || body.includes('"app":999');
      if (!isLogApp) {
        // 401 はリトライされず、レスポンスの message がそのままエラーメッセージになる経路
        return new Response(
          JSON.stringify({ code: "CB_AU01", message: "error with token token-orders and secret super-secret-pass" }),
          { status: 401 }
        );
      }
      return original(input, init);
    };
    const notified: string[] = [];
    const notifyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      notified.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const file = writeJob(world, "01_monthly.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: failing,
      out: world.out,
      notifyFetch,
    });
    expect(code).toBe(EXIT.RUNTIME);

    const console_ = world.output.join("\n");
    const logs = JSON.stringify(logRecords(world));
    const jsonlDir = world.profile.logging.localDir;
    const jsonlText = fs
      .readdirSync(jsonlDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => fs.readFileSync(path.join(jsonlDir, f), "utf8"))
      .join("\n");
    for (const surface of [console_, logs, jsonlText, notified.join("\n")]) {
      expect(surface).not.toContain("super-secret-pass");
      expect(surface).not.toContain("token-orders");
    }
    // マスクされた形では現れる（エラーメッセージ自体は残る）
    expect(logs).toContain("***");
  });

  test("stripLiterals: log_detail の SQL からリテラルが除去される", async () => {
    world = buildWorld({ orders: ORDERS });
    world.profile.logging.stripLiterals = true;
    const source = `-- @ksql name: strip_test
-- @ksql dialect: 1
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績)
SELECT 顧客コード, SUM(金額) FROM LAPP_受注 WHERE ステータス = '受注完了' GROUP BY 顧客コード
KEY (顧客コード);
`;
    const file = writeJob(world, "01_strip.sql", source);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const logs = logRecords(world);
    expect(logs[0].log_detail).not.toContain("受注完了");
  });

  test("stripSqlLiterals の単体挙動", () => {
    expect(stripSqlLiterals("WHERE 金額 < 100 AND 名前 = 'テスト太郎'")).toBe("WHERE 金額 < ? AND 名前 = ?");
    // 識別子内の数字（t1）は保持され、'' エスケープを含む文字列は 1 つの ? になる
    expect(stripSqlLiterals("SELECT * FROM t1 WHERE a = 'it''s'")).toBe("SELECT * FROM t1 WHERE a = ?");
  });

  test("SecretMasker は既知の秘密のみ置換する", () => {
    const masker = new SecretMasker({
      name: "x",
      baseUrl: "https://x",
      auth: { type: "password", username: "u", password: "p@ssw0rd-long" },
      apps: { a: { id: 1, tokens: ["tok-1234567890"] } },
      limits: { maxApiCalls: null, maxReadRows: null, maxTempRows: null, batchTimeoutSec: null },
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, respectRetryAfter: true },
      notifications: {},
      logging: { localDir: ".", maskFields: [], stripLiterals: false },
      httpTimeoutMs: 1000,
    });
    expect(masker.mask("error tok-1234567890 / p@ssw0rd-long / other")).toBe("error *** / *** / other");
  });
});
