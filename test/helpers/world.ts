import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_LIMITS, DEFAULT_LOGGING, DEFAULT_RETRY, ResolvedProfile } from "../../src/config";
import { MockKintone } from "./mockKintone";

export const ORDER_APP = 100;
export const CUSTOMER_APP = 200;
export const LOG_APP = 999;

export interface TestWorld {
  dir: string;
  jobsDir: string;
  profile: ResolvedProfile;
  mock: MockKintone;
  output: string[];
  out: (line: string) => void;
  cleanup: () => void;
}

/** 受注 / 顧客マスタ / 実行ログの 3 アプリを持つ結合テスト環境を組み立てる */
export function buildWorld(options: {
  orders?: Array<Record<string, string>>;
  customers?: Array<Record<string, string>>;
  logRecords?: Array<Record<string, string>>;
  customerUnique?: boolean;
  withLogApp?: boolean;
  profilePatch?: Partial<ResolvedProfile>;
} = {}): TestWorld {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-it-"));
  const jobsDir = path.join(dir, "jobs");
  fs.mkdirSync(jobsDir);
  const prevCwd = process.cwd();
  process.chdir(dir);

  const withLogApp = options.withLogApp !== false;
  const profile: ResolvedProfile = {
    name: "test",
    baseUrl: "https://mock.cybozu.com",
    timezone: "Asia/Tokyo",
    auth: { type: "apiToken" },
    apps: {
      受注: { id: ORDER_APP, tokens: ["token-orders"] },
      顧客マスタ: { id: CUSTOMER_APP, tokens: ["token-cust-read", "token-cust-write"] },
      ...(withLogApp ? { 実行ログ: { id: LOG_APP, tokens: ["token-logs"] } } : {}),
    },
    ...(withLogApp ? { logApp: "実行ログ" } : {}),
    limits: { ...DEFAULT_LIMITS },
    retry: { ...DEFAULT_RETRY, maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
    notifications: {},
    logging: { ...DEFAULT_LOGGING, localDir: path.join(dir, ".ksql", "logs") },
    httpTimeoutMs: 5000,
    ...options.profilePatch,
  };

  const mock = new MockKintone([
    {
      id: ORDER_APP,
      name: "受注",
      expectedToken: "token-orders",
      fields: {
        顧客コード: { type: "SINGLE_LINE_TEXT" },
        金額: { type: "NUMBER" },
        受注日: { type: "DATE" },
        ステータス: { type: "DROP_DOWN" },
      },
      records: options.orders ?? [],
    },
    {
      id: CUSTOMER_APP,
      name: "顧客マスタ",
      expectedToken: "token-cust-read,token-cust-write",
      fields: {
        顧客コード: { type: "SINGLE_LINE_TEXT", unique: options.customerUnique !== false },
        当月受注件数: { type: "NUMBER" },
        当月売上実績: { type: "NUMBER" },
        最終集計日時: { type: "DATETIME" },
      },
      records: options.customers ?? [],
    },
    {
      id: LOG_APP,
      name: "実行ログ",
      expectedToken: "token-logs",
      fields: {
        record_type: { type: "DROP_DOWN" },
        status: { type: "DROP_DOWN" },
        batch_id: { type: "SINGLE_LINE_TEXT" },
        parent_batch_id: { type: "SINGLE_LINE_TEXT" },
        job_key: { type: "SINGLE_LINE_TEXT", unique: true },
        job_key_done: { type: "SINGLE_LINE_TEXT" },
        script_name: { type: "SINGLE_LINE_TEXT" },
        profile: { type: "SINGLE_LINE_TEXT" },
        as_of: { type: "DATETIME" },
        started_at: { type: "DATETIME" },
        finished_at: { type: "DATETIME" },
        duration_sec: { type: "NUMBER" },
        read_count: { type: "NUMBER" },
        written_count: { type: "NUMBER" },
        last_written_key: { type: "SINGLE_LINE_TEXT" },
        api_calls: { type: "NUMBER" },
        executed_by: { type: "SINGLE_LINE_TEXT" },
        host: { type: "SINGLE_LINE_TEXT" },
        git_ref: { type: "SINGLE_LINE_TEXT" },
        ksql_version: { type: "SINGLE_LINE_TEXT" },
        error_message: { type: "MULTI_LINE_TEXT" },
        log_detail: { type: "MULTI_LINE_TEXT" },
      },
      records: options.logRecords ?? [],
    },
  ]);

  const output: string[] = [];
  return {
    dir,
    jobsDir,
    profile,
    mock,
    output,
    out: (line) => output.push(line),
    cleanup: () => {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function writeJob(world: TestWorld, fileName: string, source: string): string {
  const file = path.join(world.jobsDir, fileName);
  fs.writeFileSync(file, source);
  return file;
}

/** ログアプリの最新 JOB レコードを取得 */
export function logRecords(world: TestWorld): Array<Record<string, string>> {
  return world.mock.app(LOG_APP).records.map((row) => ({ ...row.values, $id: String(row.id) }));
}

export function customerRecords(world: TestWorld): Array<Record<string, string>> {
  return world.mock.app(CUSTOMER_APP).records.map((row) => ({ ...row.values, $id: String(row.id) }));
}

/** 設計書 3.1 相当のサンプルジョブ（@ 付き時刻関数） */
export const SAMPLE_JOB = `-- @ksql name: monthly_sales_sync
-- @ksql timeout: 600
-- @ksql dialect: 1

ASSERT (
  SELECT COUNT(*) FROM LAPP_受注
  WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND 金額 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

CREATE TEMP TABLE temp_monthly_summary AS
SELECT 顧客コード, COUNT(レコード番号) AS 受注件数, SUM(金額) AS 当月売上合計
FROM LAPP_受注
WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START() AND ステータス = '受注完了'
GROUP BY 顧客コード;

EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる受注データが 0 件のためスキップ';

UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
SELECT 顧客コード, 受注件数, 当月売上合計, @NOW()
FROM temp_monthly_summary
KEY (顧客コード);
`;

/** 2026-08 内の as-of（テストの基準時刻） */
export const AS_OF = "2026-08-21T09:00:00+09:00";
