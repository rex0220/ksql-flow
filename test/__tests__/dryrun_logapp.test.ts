import * as fs from "fs";
import { runCommand } from "../../src/commands/run";
import { runAllCommand } from "../../src/commands/runAll";
import { parseArgs } from "../../src/cli";
import { checkLogAppCommand, initLogAppCommand } from "../../src/commands/initLogapp";
import { LogAppClient } from "../../src/logapp";
import { EXIT } from "../../src/types";
import { AS_OF, buildWorld, customerRecords, LOG_APP, SAMPLE_JOB, TestWorld, writeJob } from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

const ORDERS = [{ 顧客コード: "C1", 金額: "100", 受注日: "2026-08-05", ステータス: "受注完了" }];

function mutationRequests(world: TestWorld) {
  return world.mock.requests.filter((request) => {
    if (request.method === "GET") return false;
    return !request.path.endsWith("/records/cursor.json");
  });
}

describe("--dry-run（fix4: v3.71.0 差分プレビュー）", () => {
  test("§3.1 サンプルを実測プレビューし、kintone mutation 0・ローカル JSONL のみ", async () => {
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
    expect(text).toContain("読み取り");
    expect(text).toContain("書き込み予定");
    expect(text).toContain("INSERT 1 件 / UPDATE 0 件 / DELETE 0 件");
    expect(text).toContain("実測 API 消費");
    expect(text).toContain("変更サンプル");
    expect(customerRecords(world)).toHaveLength(0);
    expect(mutationRequests(world)).toHaveLength(0);
    expect(fs.existsSync(`${world.dir}/.ksql/state-test.json`)).toBe(false);
    const jsonl = fs.readdirSync(world.profile.logging.localDir).filter((name) => name.endsWith(".jsonl"));
    expect(jsonl).toHaveLength(1);
    expect(fs.readFileSync(`${world.profile.logging.localDir}/${jsonl[0]}`, "utf8")).toContain("dry_run_finish");
  });

  test("dialect 1 prepare 検証エラーは preview 前に Exit 1", async () => {
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
    expect(mutationRequests(world)).toHaveLength(0);
  });

  test("ASSERT 違反は ABORTED になる表示 + Exit 2", async () => {
    world = buildWorld({ orders: [{ ...ORDERS[0], 金額: "-1" }] });
    const file = writeJob(world, "01_aborted.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.ABORTED);
    expect(world.output.join("\n")).toContain("ABORTED になる");
    expect(mutationRequests(world)).toHaveLength(0);
  });

  test("EXIT SUCCESS IF 成立は NO_DATA 表示 + Exit 0、後続 DML は実行しない", async () => {
    world = buildWorld({ orders: [] });
    const file = writeJob(world, "01_no_data.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const text = world.output.join("\n");
    expect(text).toContain("NO_DATA になる");
    expect(text).toContain("INSERT 0 件 / UPDATE 0 件 / DELETE 0 件");
    expect(mutationRequests(world)).toHaveLength(0);
  });

  test("maskFields と stripLiterals の趣旨を before/after・キーへ適用", async () => {
    world = buildWorld({
      orders: ORDERS,
      customers: [{ 顧客コード: "C1", 当月受注件数: "9", 当月売上実績: "50" }],
    });
    world.profile.logging.maskFields = ["当月売上実績"];
    world.profile.logging.stripLiterals = true;
    const file = writeJob(
      world,
      "01_mask.sql",
      `${SAMPLE_JOB}\nDELETE FROM LAPP_顧客マスタ WHERE 顧客コード = 'C1';\n`
    );
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const text = world.output.join("\n");
    expect(text).toContain("当月売上実績: *** → ***");
    expect(text).toContain("顧客コード=?");
    expect(text).not.toContain("当月売上実績: 50");
    expect(text).toContain("(削除予定)");
    expect(mutationRequests(world)).toHaveLength(0);
  });

  test("--sample N と --json: 上限件数の機械可読オブジェクトを返す", async () => {
    const parsed = parseArgs(["run", "-f", "job.sql", "--dry-run", "--sample", "2", "--json"]);
    expect(parsed.flags.get("--sample")).toBe("2");
    expect(parsed.flags.get("--json")).toBe(true);
    world = buildWorld({
      orders: Array.from({ length: 4 }, (_, index) => ({
        顧客コード: `C${index + 1}`,
        金額: String(100 + index),
        受注日: "2026-08-05",
        ステータス: "受注完了",
      })),
    });
    const file = writeJob(world, "01_json.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      sample: 2,
      json: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output).toHaveLength(1);
    const report = JSON.parse(world.output[0]) as { formatVersion: number; kind: string; sampleLimit: number; samples: unknown[] };
    expect(report.formatVersion).toBe(1);
    expect(report.kind).toBe("DRY_RUN");
    expect(report.sampleLimit).toBe(2);
    expect(report.samples).toHaveLength(2);
  });

  test("不正な --sample は読取開始前に Exit 1", async () => {
    world = buildWorld({ orders: ORDERS });
    const file = writeJob(world, "01_bad_sample.sql", SAMPLE_JOB);
    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      sample: 51,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.mock.requests).toHaveLength(0);
    expect(world.output.join("\n")).toContain("1〜50");
  });

  test("maxApiCalls 超過は既取得 preview を残して安全停止する", async () => {
    world = buildWorld({ customers: [{ 顧客コード: "C1", 当月売上実績: "50" }] });
    const file = writeJob(
      world,
      "01_limit.sql",
      `-- @ksql dialect: 1
INSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) VALUES ('NEW', 1);
UPDATE LAPP_顧客マスタ SET 当月売上実績 = 99 WHERE 顧客コード = 'C1';
UPDATE LAPP_顧客マスタ SET 当月売上実績 = 98 WHERE 顧客コード = 'C1';
UPDATE LAPP_顧客マスタ SET 当月売上実績 = 97 WHERE 顧客コード = 'C1';
UPDATE LAPP_顧客マスタ SET 当月売上実績 = 96 WHERE 顧客コード = 'C1';
UPDATE LAPP_顧客マスタ SET 当月売上実績 = 95 WHERE 顧客コード = 'C1';
`
    );
    const code = await runCommand(world.profile, file, {
      dryRun: true,
      maxApiCalls: 4,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.RUNTIME);
    const text = world.output.join("\n");
    expect(text).toContain("INSERT 1 件");
    expect(text).toContain("maxApiCalls=4");
    expect(mutationRequests(world)).toHaveLength(0);
  });

  test("run-all --dry-run は依存順・ロックなしで注意文を先頭表示し、JSON も一括出力", async () => {
    world = buildWorld({ orders: ORDERS });
    writeJob(world, "01_first.sql", `-- @ksql name: first\n-- @ksql dialect: 1\nSELECT * FROM LAPP_受注;\n`);
    writeJob(world, "02_second.sql", `-- @ksql name: second\n-- @ksql depends_on: first\n-- @ksql dialect: 1\nSELECT * FROM LAPP_受注;\n`);
    const code = await runAllCommand(world.profile, world.jobsDir, {
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output[0]).toContain("ジョブ間のデータ依存は再現されません");
    expect(world.output.join("\n").indexOf("01_first.sql")).toBeLessThan(world.output.join("\n").indexOf("02_second.sql"));
    expect(mutationRequests(world)).toHaveLength(0);

    world.output.length = 0;
    const jsonCode = await runAllCommand(world.profile, world.jobsDir, {
      dryRun: true,
      json: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(jsonCode).toBe(EXIT.OK);
    expect(world.output).toHaveLength(1);
    const batch = JSON.parse(world.output[0]) as { formatVersion: number; kind: string; warning: string; jobs: unknown[] };
    expect(batch.formatVersion).toBe(1);
    expect(batch.kind).toBe("DRY_RUN_BATCH");
    expect(batch.warning).toContain("データ依存は再現されません");
    expect(batch.jobs).toHaveLength(2);
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
    for (const code of ["correlation_id", "attempt_id", "execution_id", "job_id"]) {
      expect(created.def.fields[code]).toMatchObject({ type: "SINGLE_LINE_TEXT" });
      expect(created.def.fields[code]?.unique).not.toBe(true);
      expect(created.def.fields[code]?.required).not.toBe(true);
    }
    expect(created.def.fields["runner_execution_started_at"]).toMatchObject({ type: "DATETIME" });
    expect(created.def.fields["status"]?.options).toContain("CANCELLED");
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

  test("--check-logapp: v0.4 の全フィールドと CANCELLED があれば従来どおり OK", async () => {
    world = buildWorld({ withDeletedCount: true });
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("OK");
    expect(world.output.join("\n")).not.toContain("任意フィールド deleted_count が未追加");
  });

  test("--check-logapp: deleted_count がなくても案内付きで OK", async () => {
    world = buildWorld({});
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("OK");
    expect(world.output.join("\n")).toContain("任意フィールド deleted_count が未追加");
  });

  test("--check-logapp: v0.3 相当アプリは相関フィールドと CANCELLED がなくても案内付きで OK", async () => {
    world = buildWorld({ withOrchestratorFields: false, withCancelledStatus: false });
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.OK);
    const text = world.output.join("\n");
    for (const field of ["correlation_id", "attempt_id", "execution_id", "job_id", "runner_execution_started_at"]) {
      expect(text).toContain(`任意フィールド ${field} が未追加です`);
    }
    expect(text).toContain("orchestrator/kSQL-FlowNet 実行時のみ必須");
    expect(text).toContain("status の任意選択肢 CANCELLED が未追加です");
    expect(text).toContain("旧アプリでは cancel 時に pending 退避して継続");
  });

  test("--check-logapp: deleted_count が NUMBER 以外なら NG", async () => {
    world = buildWorld({ withDeletedCount: true });
    world.mock.app(LOG_APP).def.fields.deleted_count.type = "SINGLE_LINE_TEXT";
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain('フィールド "deleted_count" のタイプ');
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

  test("--check-logapp: 必須フィールド job_key の欠落は引き続き NG (Exit 1)", async () => {
    world = buildWorld({});
    delete (world.mock.app(LOG_APP).def.fields as Record<string, unknown>)["job_key"];
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain('フィールド "job_key"');
  });

  test("--check-logapp: record_type / status の不足・過剰選択肢を NG 表示する", async () => {
    world = buildWorld({});
    world.mock.app(LOG_APP).def.fields.record_type.options = ["BATCH"];
    world.mock.app(LOG_APP).def.fields.status.options = [
      "SUCCESS", "NO_DATA", "FAILED", "ABORTED", "SKIPPED", "RUNNING", "UNKNOWN",
    ];
    const code = await checkLogAppCommand(world.profile, {
      baseFetch: world.mock.fetch,
      out: world.out,
    });
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("不足: JOB");
    expect(world.output.join("\n")).toContain("不足: TIMEOUT");
    expect(world.output.join("\n")).toContain("過剰: UNKNOWN");
    expect(world.output.join("\n")).toContain("status の任意選択肢 CANCELLED が未追加です");
  });
});

describe("ログアプリの DROP_DOWN query", () => {
  test("record_type / status は実 kintone が受理する IN 演算子を使う", async () => {
    const queries: string[] = [];
    const fieldLists: string[][] = [];
    const client = {
      getRecords: jest.fn(async (request: { query?: string; fields?: string[] }) => {
        queries.push(request.query ?? "");
        fieldLists.push(request.fields ?? []);
        return { records: [] };
      }),
    };
    const logApp = new LogAppClient(client as never, LOG_APP, {} as never, {} as never);

    await logApp.findLatestBatch("dev");
    await logApp.listBatchJobs("batch-id");
    await logApp.listRunning("dev");

    expect(queries[0]).toContain('record_type in ("BATCH")');
    expect(queries[1]).toContain('record_type in ("JOB")');
    expect(queries[2]).toContain('status in ("RUNNING")');
    expect(fieldLists[2]).toEqual(expect.arrayContaining(["$revision", "host", "script_name"]));
  });
});
