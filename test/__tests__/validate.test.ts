import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { validateCommand } from "../../src/commands/validate";
import { ResolvedProfile, DEFAULT_RETRY, DEFAULT_LIMITS, DEFAULT_LOGGING } from "../../src/config";
import { EXIT } from "../../src/types";
import { MockKintone } from "../helpers/mockKintone";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-validate-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeProfile(): ResolvedProfile {
  return {
    name: "test",
    baseUrl: "https://mock.cybozu.com",
    timezone: "Asia/Tokyo",
    auth: { type: "apiToken" },
    apps: {
      受注: { id: 100, tokens: ["token-orders"] },
      顧客マスタ: { id: 200, tokens: ["token-cust"] },
    },
    limits: { ...DEFAULT_LIMITS },
    retry: { ...DEFAULT_RETRY, maxAttempts: 1 },
    notifications: {},
    logging: { ...DEFAULT_LOGGING },
    httpTimeoutMs: 5000,
  };
}

function makeMock(customerUnique = true): MockKintone {
  return new MockKintone([
    {
      id: 100,
      fields: {
        顧客コード: { type: "SINGLE_LINE_TEXT" },
        金額: { type: "NUMBER" },
        受注日: { type: "DATE" },
        ステータス: { type: "DROP_DOWN" },
      },
    },
    {
      id: 200,
      fields: {
        顧客コード: { type: "SINGLE_LINE_TEXT", unique: customerUnique },
        当月売上実績: { type: "NUMBER" },
        当月受注件数: { type: "NUMBER" },
        最終集計日時: { type: "DATETIME" },
      },
    },
  ]);
}

const VALID_JOB = `-- @ksql name: monthly_sync
-- @ksql dialect: 1

ASSERT (SELECT COUNT(*) FROM LAPP_受注 WHERE 金額 < 0) = 0, 'マイナス売上あり';

CREATE TEMP TABLE summary AS
SELECT 顧客コード, SUM(金額) AS 当月売上合計 FROM LAPP_受注 GROUP BY 顧客コード;

EXIT SUCCESS IF (SELECT COUNT(*) FROM summary) = 0, '対象 0 件';

UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績)
SELECT 顧客コード, 当月売上合計 FROM summary
KEY (顧客コード);
`;

function writeJob(name: string, source: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

async function run(profile: ResolvedProfile, files: string[] | { dir: string }, mock: MockKintone, strict = false) {
  const lines: string[] = [];
  const code = await validateCommand(profile, files, {
    strict,
    baseFetch: mock.fetch,
    out: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

describe("validate", () => {
  test("正しい dialect 1 ジョブは Exit 0", async () => {
    const file = writeJob("01_monthly.sql", VALID_JOB);
    const { code, output } = await run(makeProfile(), [file], makeMock());
    expect(output).toContain("OK");
    expect(code).toBe(EXIT.OK);
  });

  test("未定義の論理アプリは Exit 1", async () => {
    const file = writeJob("01_bad.sql", `-- @ksql dialect: 1\nSELECT * FROM LAPP_未定義;\n`);
    const { code, output } = await run(makeProfile(), [file], makeMock());
    expect(code).toBe(EXIT.VALIDATION);
    // apps マップ指定時、未定義論理名は parseScript が即時エラーにする（KSQL1101 相当）
    expect(output).toMatch(/KSQL1101|LAPP_未定義/);
  });

  test("UPSERT キーが重複禁止でない場合は KSQL1303 で Exit 1（フル検証）", async () => {
    const file = writeJob("01_key.sql", VALID_JOB);
    const { code, output } = await run(makeProfile(), [file], makeMock(false));
    expect(code).toBe(EXIT.VALIDATION);
    expect(output).toMatch(/KSQL1303/);
  });

  test("素の INSERT は警告、--strict でエラー（KSQL1305）", async () => {
    const source = `-- @ksql dialect: 1\nINSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) VALUES ('C1', 100);\n`;
    const file = writeJob("01_insert.sql", source);
    const relaxed = await run(makeProfile(), [file], makeMock());
    expect(relaxed.code).toBe(EXIT.OK);
    expect(relaxed.output).toMatch(/KSQL1305/);

    const strict = await run(makeProfile(), [file], makeMock(), true);
    expect(strict.code).toBe(EXIT.VALIDATION);
  });

  test("エンジン実体で 20 文ちょうどは成功・21 文は Exit 1", async () => {
    const source = (count: number) => `-- @ksql dialect: 1\n${Array.from(
      { length: count },
      () => "SELECT COUNT(*) FROM LAPP_受注;"
    ).join("\n")}\n`;
    const twenty = await run(makeProfile(), [writeJob("01_twenty.sql", source(20))], makeMock());
    expect(twenty.code).toBe(EXIT.OK);
    const twentyOne = await run(makeProfile(), [writeJob("02_twenty_one.sql", source(21))], makeMock());
    expect(twentyOne.code).toBe(EXIT.VALIDATION);
    expect(twentyOne.output).toMatch(/文数上限|20/);
  });

  test("validate-all: ディレクトリ一括・depends_on 未定義はエラー", async () => {
    writeJob("01_a.sql", VALID_JOB);
    writeJob("02_b.sql", `-- @ksql name: second\n-- @ksql depends_on: missing_job\n-- @ksql dialect: 1\nSELECT * FROM LAPP_受注;\n`);
    const { code, output } = await run(makeProfile(), { dir }, makeMock());
    expect(code).toBe(EXIT.VALIDATION);
    expect(output).toMatch(/missing_job/);
  });

  test("validate-all: 全ファイル OK は Exit 0", async () => {
    writeJob("01_a.sql", VALID_JOB);
    writeJob("02_b.sql", `-- @ksql name: second\n-- @ksql depends_on: monthly_sync\n-- @ksql dialect: 1\nSELECT * FROM LAPP_受注;\n`);
    const { code } = await run(makeProfile(), { dir }, makeMock());
    expect(code).toBe(EXIT.OK);
  });
});
