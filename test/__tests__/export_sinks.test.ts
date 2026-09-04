import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createExecutionContext,
  disposeExecutionContext,
  executeStatement,
  parseScript,
  serializeCsvExport,
  type FlowKintoneClient,
  type StatementResult,
} from "@rex0220/kintone-sql-tools/flow";
import { atomicWriteExportFile } from "../../src/exportFiles";
import { ExportOptionError, ExportSinkRegistry, hasExportEngineCapability, parseExportOutputs } from "../../src/exportSinks";

const client: FlowKintoneClient = {
  async getRecords() { return { records: [] }; },
  async openCursor() { return { totalCount: 0, async nextPage() { return { records: [], next: false }; }, async close() {} }; },
  async postRecords() { return { ids: [] }; },
  async putRecords() {},
  async deleteRecords() {},
  async getApps() { return []; },
  async getFields() { return []; },
  async getNumberPrecision() { return { digits: 16, decimalPlaces: 4, roundingMode: "HALF_EVEN" }; },
  async getProcessStatuses() { return { enable: false, states: null }; },
};

describe("export CLI input contract", () => {
  test("detects the B179 public functions without hard-coding the engine version string", () => {
    expect(hasExportEngineCapability()).toBe(true);
  });
  test("splits only the first equals and preserves Windows-style unnamed paths", () => {
    const named = parseExportOutputs(["export=C:\\out\\a=b.csv"], "utf8", undefined, undefined, "C:\\work", "win32")!;
    expect(named.inputs[0]).toMatchObject({ name: "export", sinkName: "export" });
    expect(named.inputs[0].targetPath).toContain("a=b.csv");
    const unnamed = parseExportOutputs(["C:\\out\\a.csv"], undefined, undefined, undefined, "C:\\work", "win32")!;
    expect(unnamed.inputs[0].sinkName).toBeUndefined();
  });

  test.each([
    [["=a.csv"]], [["#bad=a.csv"]], [["a.csv", "b.csv"]],
    [["a=x.csv", "b=x.csv"]], [["a=x.csv", "a=y.csv"]], [["a=-"]],
  ])("rejects invalid or ambiguous outputs %#", (values) => {
    expect(() => parseExportOutputs(values)).toThrow(ExportOptionError);
  });

  test("rejects invalid encoding/timezone, unused modifiers, and result collision", () => {
    expect(() => parseExportOutputs([], "sjis")).toThrow(ExportOptionError);
    expect(() => parseExportOutputs(["a.csv"], "SJIS")).toThrow(ExportOptionError);
    expect(() => parseExportOutputs(["a.csv"], "utf8", "Invalid/Zone")).toThrow(ExportOptionError);
    expect(() => parseExportOutputs(["a.csv"], "utf8", undefined, "a.csv")).toThrow(ExportOptionError);
  });
});

describe("export registry", () => {
  test("pins the engine public value-conversion and RFC 4180 golden", () => {
    const result = serializeCsvExport({
      columns: ["scalar", "choices", "people", "number", "date", "datetime", "quoted", "empty"],
      rows: [{
        scalar: "0012.50",
        choices: '["A","B"]',
        people: '[{"code":"u1","name":"One"},{"code":"u2","name":"Two"}]',
        number: "1.25e+22",
        date: "2026-03-08",
        datetime: "2026-03-08T07:00:00.123Z",
        quoted: 'a,"b"',
        empty: null,
      }],
      columnMeta: new Map([
        ["choices", { fieldType: "MULTI_SELECT" }],
        ["people", { fieldType: "USER_SELECT" }],
        ["number", { fieldType: "NUMBER" }],
        ["date", { fieldType: "DATE" }],
        ["datetime", { fieldType: "DATETIME" }],
      ]),
    }, { timezone: "America/New_York" });
    expect(result.text).toBe([
      "scalar,choices,people,number,date,datetime,quoted,empty",
      '0012.50,"A\nB","u1\nu2",12500000000000000000000,2026-03-08,2026-03-08T03:00:00.123-04:00,"a,""b""",',
      "",
    ].join("\r\n"));
    expect(result.receipt).toEqual({ rows: 1, columns: 8, bytes: result.data.byteLength, encoding: "utf8" });
    expect(Array.from(result.data.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(() => serializeCsvExport({
      columns: ["Lines"], rows: [], columnMeta: new Map([["Lines", { fieldType: "SUBTABLE" }]]),
    })).toThrow(expect.objectContaining({ code: "ExportSinkUnsupportedColumnError" }));
  });

  test("serializes all named sinks before committing and publishes path-free receipts", async () => {
    const parsed = parseScript("CREATE TEMP TABLE #a AS SELECT 'A' AS code; CREATE TEMP TABLE #b AS SELECT 'B' AS code");
    const options = parseExportOutputs(["a=a.csv", "b=b.csv"])!;
    const writes: Array<{ target: string; data: Uint8Array }> = [];
    const registry = new ExportSinkRegistry(options, parsed.statements, async (target, data) => {
      writes.push({ target, data });
    });
    const context = createExecutionContext({
      client, statements: parsed.statements, meta: parsed.meta, exportSinks: registry.flowDeclarations(),
    });
    const results: StatementResult[] = [];
    for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
    registry.serialize(context, results);
    await disposeExecutionContext(context);
    await registry.commit();
    expect(writes).toHaveLength(2);
    expect(new TextDecoder().decode(writes[0].data)).toBe("code\r\nA\r\n");
    expect(registry.snapshotOutputFiles()).toEqual([
      expect.objectContaining({ name: "a", bytes: 9, rows: 1, encoding: "utf8", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ name: "b", bytes: 9, rows: 1, encoding: "utf8", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    expect(JSON.stringify(registry.snapshotOutputFiles())).not.toContain(path.resolve("a.csv"));
  });

  test("not-created is skipped and a later commit failure retains only completed receipts", async () => {
    const parsed = parseScript("-- @ksql dialect: 1\nEXIT SUCCESS IF 1 = 1, 'done'; CREATE TEMP TABLE #a AS SELECT 'A' AS code; CREATE TEMP TABLE #b AS SELECT 'B' AS code");
    const options = parseExportOutputs(["a=a.csv", "b=b.csv"])!;
    const registry = new ExportSinkRegistry(options, parsed.statements, async () => undefined);
    const context = createExecutionContext({
      client, statements: parsed.statements, meta: parsed.meta, exportSinks: registry.flowDeclarations(),
    });
    const results: StatementResult[] = [];
    for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
    registry.serialize(context, results);
    await disposeExecutionContext(context);
    await registry.commit();
    expect(registry.snapshotOutputFiles()).toEqual([]);

    const materialized = parseScript("CREATE TEMP TABLE #a AS SELECT 'A' AS code; CREATE TEMP TABLE #b AS SELECT 'B' AS code");
    let calls = 0;
    const partial = new ExportSinkRegistry(options, materialized.statements, async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("rename failed"), { code: "EPERM" });
    });
    const secondContext = createExecutionContext({
      client, statements: materialized.statements, meta: materialized.meta, exportSinks: partial.flowDeclarations(),
    });
    const secondResults: StatementResult[] = [];
    for (const statement of materialized.statements) secondResults.push(await executeStatement(statement, secondContext));
    partial.serialize(secondContext, secondResults);
    await disposeExecutionContext(secondContext);
    await expect(partial.commit()).rejects.toMatchObject({ code: "EPERM" });
    expect(partial.snapshotOutputFiles().map((item) => item.name)).toEqual(["a"]);
  });

  test("a later SJIS serialization error prevents every file write", async () => {
    const parsed = parseScript("CREATE TEMP TABLE #a AS SELECT 'A' AS value; CREATE TEMP TABLE #b AS SELECT '😀' AS value");
    const options = parseExportOutputs(["a=a.csv", "b=b.csv"], "sjis")!;
    const writer = jest.fn(async () => undefined);
    const registry = new ExportSinkRegistry(options, parsed.statements, writer);
    const context = createExecutionContext({
      client, statements: parsed.statements, meta: parsed.meta, exportSinks: registry.flowDeclarations(),
    });
    const results: StatementResult[] = [];
    for (const statement of parsed.statements) results.push(await executeStatement(statement, context));
    expect(() => registry.serialize(context, results)).toThrow(expect.objectContaining({ code: "ExportSinkEncodingError" }));
    await disposeExecutionContext(context);
    await registry.commit();
    expect(writer).not.toHaveBeenCalled();
    expect(registry.snapshotOutputFiles()).toEqual([]);
  });
});

describe("atomic export writer", () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test("writes exact bytes and leaves no temporary file", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-export-"));
    const target = path.join(dir, "out.csv");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await atomicWriteExportFile(target, bytes);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(bytes));
    expect(fs.readdirSync(dir)).toEqual(["out.csv"]);
  });

  test("rename failure preserves the old target and cleans the temporary file", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-export-"));
    const target = path.join(dir, "out.csv");
    fs.writeFileSync(target, "old");
    await expect(atomicWriteExportFile(target, new TextEncoder().encode("new"), {
      rename: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["out.csv"]);
  });

  test("retries short writes and cleans up after fsync failure", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-export-"));
    const target = path.join(dir, "out.csv");
    const nativeOpen = fs.promises.open;
    let writeCalls = 0;
    await atomicWriteExportFile(target, new Uint8Array([1, 2, 3, 4]), {
      open: (async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await nativeOpen(...args);
        return new Proxy(handle, {
          get(object, property) {
            if (property === "write") return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              writeCalls += 1;
              return object.write(buffer, offset, Math.min(1, length), position);
            };
            return Reflect.get(object, property, object);
          },
        });
      }) as typeof fs.promises.open,
    });
    expect(writeCalls).toBe(4);
    expect(fs.readFileSync(target)).toEqual(Buffer.from([1, 2, 3, 4]));

    const failed = path.join(dir, "failed.csv");
    await expect(atomicWriteExportFile(failed, new Uint8Array([1]), {
      open: (async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await nativeOpen(...args);
        return new Proxy(handle, {
          get(object, property) {
            if (property === "sync") return async () => { throw new Error("fsync failed"); };
            return Reflect.get(object, property, object);
          },
        });
      }) as typeof fs.promises.open,
    })).rejects.toThrow("fsync failed");
    expect(fs.existsSync(failed)).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(["out.csv"]);
  });
});
