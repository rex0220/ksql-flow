import * as fs from "fs";
import * as path from "path";
import { runCommand } from "../../src/commands/run";
import { parseExportOutputs } from "../../src/exportSinks";
import { EXIT } from "../../src/types";
import { AS_OF, buildWorld, type TestWorld, writeJob } from "../helpers/world";

jest.setTimeout(30_000);

let world: TestWorld | undefined;
afterEach(() => {
  world?.cleanup();
  world = undefined;
  jest.restoreAllMocks();
});

function baseOptions() {
  return { asOf: AS_OF, baseFetch: world!.mock.fetch, out: world!.out };
}

test("standalone named and single SELECT exports use engine CSV bytes", async () => {
  world = buildWorld();
  const namedFile = writeJob(world, "named.sql", "CREATE TEMP TABLE #export AS SELECT '日本語' AS value; SELECT * FROM #export;");
  const namedTarget = path.join(world.dir, "named.csv");
  const namedCode = await runCommand(world.profile, namedFile, {
    ...baseOptions(), exportOutputs: parseExportOutputs([`export=${namedTarget}`]),
  });
  if (namedCode !== EXIT.OK) throw new Error(world.output.join("\n"));
  expect(fs.readFileSync(namedTarget, "utf8")).toBe("value\r\n日本語\r\n");

  const singleFile = writeJob(world, "single.sql", "SELECT 'A' AS code;");
  const singleTarget = path.join(world.dir, "single.csv");
  expect(await runCommand(world.profile, singleFile, {
    ...baseOptions(), exportOutputs: parseExportOutputs([singleTarget]),
  })).toBe(EXIT.OK);
  expect(fs.readFileSync(singleTarget, "utf8")).toBe("code\r\nA\r\n");
});

test("EXIT before CREATE keeps the old file and NO_DATA Exit 0", async () => {
  world = buildWorld();
  const file = writeJob(world, "no-data.sql", [
    "-- @ksql dialect: 1",
    "EXIT SUCCESS IF 1 = 1, 'done';",
    "CREATE TEMP TABLE #export AS SELECT 'new' AS value;",
  ].join("\n"));
  const target = path.join(world.dir, "out.csv");
  fs.writeFileSync(target, "old");
  expect(await runCommand(world.profile, file, {
    ...baseOptions(), exportOutputs: parseExportOutputs([`export=${target}`]),
  })).toBe(EXIT.OK);
  expect(fs.readFileSync(target, "utf8")).toBe("old");
  expect(world.output.some((line) => line.includes("NO_DATA"))).toBe(true);
});

test("invalid named declaration fails before kintone API, locks, or export files", async () => {
  world = buildWorld();
  const file = writeJob(world, "invalid.sql", "SELECT 'A' AS code;");
  const target = path.join(world.dir, "invalid.csv");
  expect(await runCommand(world.profile, file, {
    ...baseOptions(), exportOutputs: parseExportOutputs([`bad-name=${target}`]),
  })).toBe(EXIT.VALIDATION);
  expect(world.mock.requests).toHaveLength(0);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.existsSync(path.join(world.dir, ".ksql", "lock"))).toBe(false);
});

test.each(["〜", "¥", "−", "—", "😀", "한글"])(
  "SJIS %s fails closed and does not create a completed file",
  async (value) => {
    world = buildWorld();
    const file = writeJob(world, "sjis.sql", `SELECT '${value}' AS value;`);
    const target = path.join(world.dir, "sjis.csv");
    expect(await runCommand(world.profile, file, {
      ...baseOptions(), exportOutputs: parseExportOutputs([target], "sjis"),
    })).toBe(EXIT.VALIDATION);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(world.dir).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(world.output.join("\n")).toMatch(/U\+[0-9A-F]{4,6} at offset \d+/);
    expect(world.output.join("\n")).not.toContain(`SELECT '${value}'`);
  }
);

test("orchestrator result contains only path-free completed output receipts", async () => {
  world = buildWorld();
  const file = writeJob(world, "export.sql", [
    "-- @ksql name: export_job",
    "CREATE TEMP TABLE #export AS SELECT 'A' AS code;",
    "SELECT * FROM #export;",
  ].join("\n"));
  const csv = path.join(world.dir, "out.csv");
  const resultPath = path.join(world.dir, "result.json");
  const code = await runCommand(world.profile, file, {
    ...baseOptions(),
    resultJson: resultPath,
    correlationId: "network-1",
    attemptId: "attempt-1",
    expectedJobId: "export_job",
    exportOutputs: parseExportOutputs([`export=${csv}`], "utf8", undefined, resultPath),
  });
  if (code !== EXIT.OK) throw new Error(world.output.join("\n"));
  const resultText = fs.readFileSync(resultPath, "utf8");
  const result = JSON.parse(resultText) as { output_files: unknown[] };
  expect(result.output_files).toEqual([
    expect.objectContaining({ name: "export", bytes: 9, rows: 1, encoding: "utf8", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
  ]);
  expect(resultText).not.toContain(csv);
  expect(resultText.endsWith("\n")).toBe(true);
});

test("IMPORT and named EXPORT share one execution context", async () => {
  world = buildWorld();
  const input = path.join(world.dir, "input.csv");
  fs.writeFileSync(input, "顧客コード,当月売上実績\nC-EXPORT,100\n");
  const file = writeJob(world, "import-export.sql", [
    "IMPORT INTO LAPP_顧客マスタ (顧客コード, 当月売上実績) FROM CSV source ON DUPLICATE (顧客コード);",
    "CREATE TEMP TABLE #export AS SELECT 'done' AS status;",
    "SELECT * FROM #export;",
  ].join("\n"));
  const target = path.join(world.dir, "out.csv");
  expect(await runCommand(world.profile, file, {
    ...baseOptions(),
    importSources: [{ name: "source", kind: "CSV", absolutePath: input }],
    exportOutputs: parseExportOutputs([`export=${target}`]),
  })).toBe(EXIT.OK);
  expect(fs.readFileSync(target, "utf8")).toBe("status\r\ndone\r\n");
});

test("orchestrator stdout is exactly one Execution Result object plus LF", async () => {
  world = buildWorld();
  const file = writeJob(world, "stdout.sql", [
    "-- @ksql name: stdout_job",
    "CREATE TEMP TABLE #export AS SELECT 'A' AS code;",
    "SELECT * FROM #export;",
  ].join("\n"));
  const target = path.join(world.dir, "stdout.csv");
  let stdout = "";
  jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write);
  expect(await runCommand(world.profile, file, {
    ...baseOptions(), resultJson: "-", correlationId: "network-1", attemptId: "attempt-1",
    expectedJobId: "stdout_job", exportOutputs: parseExportOutputs([`export=${target}`], "utf8", undefined, "-"),
  })).toBe(EXIT.OK);
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.split("\n")).toHaveLength(2);
  expect(JSON.parse(stdout)).toMatchObject({ kind: "EXECUTION_RESULT", output_files: [{ name: "export" }] });
  expect(stdout).not.toContain("code\r\nA");
});

test(
  "rename EPERM preserves an existing materialized target",
  async () => {
    world = buildWorld();
    const file = writeJob(world, "rename.sql", "SELECT 'new' AS value;");
    const target = path.join(world.dir, "rename.csv");
    fs.writeFileSync(target, "old");
    jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EPERM" }));
    expect(await runCommand(world.profile, file, {
      ...baseOptions(), exportOutputs: parseExportOutputs([target]),
    })).toBe(EXIT.RUNTIME);
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(fs.readdirSync(world.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  }
);
