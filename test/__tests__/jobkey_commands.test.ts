import { runAllCommand } from "../../src/commands/runAll";
import { runCommand } from "../../src/commands/run";
import { validateCommand } from "../../src/commands/validate";
import { EXIT } from "../../src/types";
import { AS_OF, buildWorld, TestWorld, writeJob } from "../helpers/world";

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

function selectJob(name: string): string {
  return `-- @ksql name: ${name}\n-- @ksql dialect: 1\nSELECT COUNT(*) FROM LAPP_受注;\n`;
}

describe("job_key ガードのコマンド経路", () => {
  test("validate は不正キーを API 呼び出し前に Exit 1 にする", async () => {
    world = buildWorld();
    const file = writeJob(world, "01_bad.sql", selectJob("daily:sales"));

    const code = await validateCommand(world.profile, [file], {
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toMatch(/ジョブ名.*:.*@ksql name/);
    expect(world.mock.requests).toHaveLength(0);
  });

  test("run は予約語を API 呼び出し前に Exit 1 にする", async () => {
    world = buildWorld();
    const file = writeJob(world, "01_bad.sql", selectJob("__batch__"));

    const code = await runCommand(world.profile, file, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toMatch(/__batch__.*予約語.*@ksql name/);
    expect(world.mock.requests).toHaveLength(0);
  });

  test("run-all は不正 profile を API 呼び出し前に Exit 1 にする", async () => {
    world = buildWorld({ profilePatch: { name: "test:west" } });
    writeJob(world, "01_ok.sql", selectJob("daily_sales"));

    const code = await runAllCommand(world.profile, world.jobsDir, {
      asOf: AS_OF,
      baseFetch: world.mock.fetch,
      out: world.out,
    });

    expect(code).toBe(EXIT.VALIDATION);
    expect(world.output.join("\n")).toMatch(/プロファイル名.*:.*ksql\.config\.json/);
    expect(world.mock.requests).toHaveLength(0);
  });
});
