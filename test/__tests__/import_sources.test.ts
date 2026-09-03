import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseScript } from "@rex0220/kintone-sql-tools/flow";
import {
  collectRequiredImportSources,
  ImportSourceRegistry,
  InputFileMutatedError,
  parseImportInputs,
} from "../../src/importSources";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-import-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function required(sql: string) {
  return collectRequiredImportSources(parseScript(sql, { enableImport: true }).statements);
}

test("parses mixed sources, rejects cross-kind duplicates, and normalizes hashes", () => {
  const csv = path.join(dir, "a=b.csv");
  const json = path.join(dir, "b.json");
  const parsed = parseImportInputs(
    [`sales=${csv}`],
    [`people=${json}`],
    [`sales=${"A".repeat(64)}`, `people=${"b".repeat(64)}`]
  );
  expect(parsed.sources).toEqual([
    { name: "sales", kind: "CSV", absolutePath: csv, expectedSha256: "a".repeat(64) },
    { name: "people", kind: "JSON", absolutePath: json, expectedSha256: "b".repeat(64) },
  ]);
  expect(() => parseImportInputs([`same=${csv}`], [`same=${json}`], [])).toThrow(/重複/);
});

test("uses one cached byte object for hashing and the engine payload", async () => {
  const file = path.join(dir, "sales.csv");
  const content = Buffer.from("code,amount\nA,100\n", "utf8");
  fs.writeFileSync(file, content);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const registry = new ImportSourceRegistry(
    [{ name: "sales", kind: "CSV", absolutePath: file, expectedSha256: hash }],
    required("IMPORT INTO APP1 (code, amount) FROM CSV sales ENCODING UTF8;"),
    false,
    new Map(),
    () => undefined
  );
  const loader = registry.resolver("sales")!;
  const first = await loader.load();
  const second = await loader.load();
  expect(second.bytes).toBe(first.bytes);
  expect(Buffer.from(first.bytes)).toEqual(content);
  expect(registry.snapshotInputFiles()).toEqual([
    { name: "sales", sha256: hash, bytes: content.length, encoding: "UTF8" },
  ]);
});

test("preloads used sources in orchestrator mode and excludes unused supplies", async () => {
  const used = path.join(dir, "used.json");
  const unused = path.join(dir, "unused.csv");
  fs.writeFileSync(used, '[{"code":"A"}]');
  fs.writeFileSync(unused, "code\nB\n");
  const usedHash = crypto.createHash("sha256").update(fs.readFileSync(used)).digest("hex");
  const unusedHash = crypto.createHash("sha256").update(fs.readFileSync(unused)).digest("hex");
  const warnings: string[] = [];
  const registry = new ImportSourceRegistry(
    [
      { name: "used", kind: "JSON", absolutePath: used },
      { name: "unused", kind: "CSV", absolutePath: unused },
    ],
    required("IMPORT INTO APP1 (code) FROM JSON used;"),
    true,
    new Map([["used", usedHash], ["unused", unusedHash]]),
    (message) => warnings.push(message)
  );
  await registry.preloadUsed();
  expect(warnings.join("\n")).toContain("unused");
  expect(registry.snapshotInputFiles()).toEqual([
    { name: "used", sha256: usedHash, bytes: fs.statSync(used).size, encoding: "UTF8" },
  ]);
});

test("rejects missing, kind mismatch, hash mismatch, and non-regular files without path disclosure", async () => {
  const file = path.join(dir, "secret.csv");
  fs.writeFileSync(file, "code\nSECRET_CELL\n");
  expect(() => new ImportSourceRegistry([], required("IMPORT INTO APP1 (code) FROM CSV src;"), false, new Map(), () => undefined))
    .toThrow(/供給されていません/);
  expect(() => new ImportSourceRegistry(
    [{ name: "src", kind: "JSON", absolutePath: file }],
    required("IMPORT INTO APP1 (code) FROM CSV src;"), false, new Map(), () => undefined
  )).toThrow(/種別/);

  const mismatch = new ImportSourceRegistry(
    [{ name: "src", kind: "CSV", absolutePath: file, expectedSha256: "0".repeat(64) }],
    required("IMPORT INTO APP1 (code) FROM CSV src;"), false, new Map(), () => undefined
  );
  await expect(mismatch.resolver("src")!.load()).rejects.toBeInstanceOf(InputFileMutatedError);
  await expect(mismatch.resolver("src")!.load()).rejects.not.toThrow(file);

  const directorySource = new ImportSourceRegistry(
    [{ name: "src", kind: "CSV", absolutePath: dir }],
    required("IMPORT INTO APP1 (code) FROM CSV src;"), false, new Map(), () => undefined
  );
  await expect(directorySource.resolver("src")!.load()).rejects.toMatchObject({
    code: "ImportSourceNotRegularFileError",
  });
  await expect(directorySource.resolver("src")!.load()).rejects.not.toThrow(dir);
});

test("passes 10 MiB + 1 to the engine boundary but never reads more", async () => {
  const file = path.join(dir, "large.json");
  fs.writeFileSync(file, Buffer.alloc(10 * 1024 * 1024 + 100, 0x20));
  const registry = new ImportSourceRegistry(
    [{ name: "large", kind: "JSON", absolutePath: file }],
    required("IMPORT INTO APP1 (code) FROM JSON large;"), false, new Map(), () => undefined
  );
  const payload = await registry.resolver("large")!.load();
  expect(payload.bytes.byteLength).toBe(10 * 1024 * 1024 + 1);
});
