import { runCommand } from "../../src/commands/run";
import { EXIT } from "../../src/types";
import {
  AS_OF,
  buildWorld,
  customerRecords,
  TestWorld,
  writeJob,
} from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

const ORDERS = Array.from({ length: 15 }, (_, index) => ({
  顧客コード: `C${String(index + 1).padStart(2, "0")}`,
  金額: String(index + 1),
  受注日: "2026-08-05",
  ステータス: "受注完了",
}));

const FULL_SCAN_THEN_WRITE = `-- @ksql dialect: 1
SELECT * FROM LAPP_受注;
INSERT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) VALUES ('WRITTEN', 1);
`;

describe("limits.maxReadRows の実行経路", () => {
  test("maxReadRows: 10 は 15 件の FULL_SCAN を安全停止し、後続を書き込まない", async () => {
    world = buildWorld({ orders: ORDERS, withLogApp: false });
    world.profile.limits.maxReadRows = 10;
    const file = writeJob(world, "01_read_limit.sql", FULL_SCAN_THEN_WRITE);

    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      lockLocalOnly: true,
    });

    // 読取候補上限は SQL 実行エラーとして既存体系どおり Exit 1。
    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("FAILED");
    expect(world.output.join("\n")).toContain("上限（10 件）");
    expect(customerRecords(world)).toHaveLength(0);
  });

  test("maxReadRows: 100 は同じ 15 件の FULL_SCAN と後続書込を完走する", async () => {
    world = buildWorld({ orders: ORDERS, withLogApp: false });
    world.profile.limits.maxReadRows = 100;
    const file = writeJob(world, "01_read_limit.sql", FULL_SCAN_THEN_WRITE);

    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
      lockLocalOnly: true,
    });

    expect(code).toBe(EXIT.OK);
    expect(world.output.join("\n")).toContain("SUCCESS");
    expect(customerRecords(world)).toHaveLength(1);
  });

  test("dry-run でも maxReadRows: 10 をエンジンへ渡して安全停止する", async () => {
    world = buildWorld({ orders: ORDERS, withLogApp: false });
    world.profile.limits.maxReadRows = 10;
    const file = writeJob(world, "01_read_limit.sql", FULL_SCAN_THEN_WRITE);

    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      dryRun: true,
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toContain("安全停止");
    expect(world.output.join("\n")).toContain("上限（10 件）");
    expect(customerRecords(world)).toHaveLength(0);
  });
});
