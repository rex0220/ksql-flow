import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  createImportSourceResolver,
  FlowImportProviderError,
  type FlowImportSourceResolver,
  type FlowImportSourcePayload,
  type Statement,
} from "@rex0220/kintone-sql-tools/flow";
import { ConfigError } from "./errors";
import type { InputFileReceipt } from "./contract";

export type ImportKind = "CSV" | "JSON";

export interface ImportSourceInput {
  readonly name: string;
  readonly kind: ImportKind;
  readonly absolutePath: string;
  readonly expectedSha256?: string;
}

export interface ParsedImportInputs {
  readonly sources: ImportSourceInput[];
  readonly expectedSha256: ReadonlyMap<string, string>;
}

export class InputFileMutatedError extends ConfigError {
  readonly code = "INPUT_FILE_MUTATED";
  constructor(readonly sourceName: string) {
    super(`IMPORT source "${sourceName}" did not match the expected sha256.`);
    this.name = "InputFileMutatedError";
  }
}

interface RequiredImportSource {
  readonly name: string;
  readonly kind: ImportKind;
  readonly encoding?: "UTF8" | "SJIS";
}

interface LoadedSource {
  readonly payload: FlowImportSourcePayload;
  readonly receipt: InputFileReceipt;
}

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export function parseImportInputs(
  csvValues: readonly string[],
  jsonValues: readonly string[],
  expectedValues: readonly string[]
): ParsedImportInputs {
  const sources: ImportSourceInput[] = [];
  const byName = new Map<string, ImportSourceInput>();
  for (const [kind, values] of [["CSV", csvValues], ["JSON", jsonValues]] as const) {
    for (const value of values) {
      const [name, filePath] = splitNameValue(value, `--import-${kind.toLowerCase()}`);
      validateSourceName(name);
      if (filePath.length === 0 || filePath.includes("\0") || !path.isAbsolute(filePath)) {
        throw new ConfigError(`IMPORT source "${name}" の path は空でない絶対 path を指定してください`);
      }
      if (byName.has(name)) throw new ConfigError(`IMPORT source "${name}" が重複しています`);
      const source = { name, kind, absolutePath: filePath } satisfies ImportSourceInput;
      byName.set(name, source);
      sources.push(source);
    }
  }

  const expectedSha256 = new Map<string, string>();
  for (const value of expectedValues) {
    const [name, hash] = splitNameValue(value, "--expected-import-sha256");
    validateSourceName(name);
    if (!SHA256_PATTERN.test(hash)) {
      throw new ConfigError(`IMPORT source "${name}" の expected sha256 は64桁の16進数で指定してください`);
    }
    if (expectedSha256.has(name)) throw new ConfigError(`IMPORT source "${name}" の expected sha256 が重複しています`);
    expectedSha256.set(name, hash.toLowerCase());
  }

  return {
    sources: sources.map((source) => ({ ...source, expectedSha256: expectedSha256.get(source.name) })),
    expectedSha256,
  };
}

function splitNameValue(value: string, flag: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 0) throw new ConfigError(`${flag} は <name>=<value> 形式で指定してください`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function validateSourceName(name: string): void {
  if (name.length === 0 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ConfigError("IMPORT source name は空または制御文字を含む値にできません");
  }
}

export function collectRequiredImportSources(statements: readonly Statement[]): RequiredImportSource[] {
  const required = new Map<string, RequiredImportSource>();
  for (const statement of statements) {
    const candidate = statement.type === "EXPLAIN" ? statement.query : statement;
    if (candidate.type !== "IMPORT") continue;
    const current: RequiredImportSource = {
      name: candidate.source.sourceName,
      kind: candidate.source.kind,
      ...(candidate.source.kind === "JSON"
        ? { encoding: "UTF8" as const }
        : candidate.source.encoding !== undefined
          ? { encoding: candidate.source.encoding.toUpperCase() as "UTF8" | "SJIS" }
          : {}),
    };
    const previous = required.get(current.name);
    if (previous !== undefined && previous.kind !== current.kind) {
      throw new ConfigError(`IMPORT source "${current.name}" はCSVとJSONの両方として参照されています`);
    }
    if (previous?.encoding !== undefined && current.encoding !== undefined && previous.encoding !== current.encoding) {
      throw new ConfigError(`IMPORT source "${current.name}" のENCODING指定が一致しません`);
    }
    required.set(current.name, previous?.encoding !== undefined ? previous : current);
  }
  return [...required.values()].sort((a, b) => compareNames(a.name, b.name));
}

export class ImportSourceRegistry {
  readonly resolver: FlowImportSourceResolver;
  private readonly sourceByName = new Map<string, ImportSourceInput>();
  private readonly requiredByName = new Map<string, RequiredImportSource>();
  private readonly loaded = new Map<string, Promise<LoadedSource>>();

  constructor(
    sources: readonly ImportSourceInput[],
    required: readonly RequiredImportSource[],
    orchestrator: boolean,
    expectedSha256: ReadonlyMap<string, string>,
    warn: (message: string) => void
  ) {
    for (const source of sources) {
      validateSourceName(source.name);
      if (this.sourceByName.has(source.name)) throw new ConfigError(`IMPORT source "${source.name}" が重複しています`);
      if (!path.isAbsolute(source.absolutePath) || source.absolutePath.includes("\0")) {
        throw new ConfigError(`IMPORT source "${source.name}" の path は空でない絶対 path を指定してください`);
      }
      const expected = expectedSha256.get(source.name) ?? source.expectedSha256;
      if (expected !== undefined && !SHA256_PATTERN.test(expected)) {
        throw new ConfigError(`IMPORT source "${source.name}" の expected sha256 は64桁の16進数で指定してください`);
      }
      this.sourceByName.set(source.name, {
        ...source,
        ...(expected !== undefined ? { expectedSha256: expected.toLowerCase() } : {}),
      });
    }
    for (const item of required) this.requiredByName.set(item.name, item);

    for (const item of required) {
      const supplied = this.sourceByName.get(item.name);
      if (supplied === undefined) throw new ConfigError(`SQLが要求するIMPORT source "${item.name}" が供給されていません`);
      if (supplied.kind !== item.kind) throw new ConfigError(`IMPORT source "${item.name}" の種別がSQLと一致しません`);
    }
    for (const source of sources) {
      if (!this.requiredByName.has(source.name)) warn(`  警告: 供給されたIMPORT source "${source.name}" はSQLで使用されていません`);
    }
    for (const name of expectedSha256.keys()) {
      if (!this.sourceByName.has(name)) throw new ConfigError(`expected sha256 に余剰なIMPORT source "${name}" があります`);
    }
    if (orchestrator) {
      for (const source of sources) {
        if (!expectedSha256.has(source.name)) throw new ConfigError(`IMPORT source "${source.name}" のexpected sha256がありません`);
      }
    }

    this.resolver = createImportSourceResolver(sources.map((source) => ({
      name: source.name,
      loader: { load: async () => (await this.load(source.name)).payload },
    })));
  }

  async preloadUsed(): Promise<void> {
    for (const source of [...this.requiredByName.values()].sort((a, b) => compareNames(a.name, b.name))) {
      await this.load(source.name);
    }
  }

  snapshotInputFiles(): InputFileReceipt[] {
    const receipts: InputFileReceipt[] = [];
    for (const [name, promise] of this.loaded) {
      // Settled values are mirrored synchronously by load() into loadedValues.
      const value = this.loadedValues.get(name);
      if (value !== undefined) receipts.push(value.receipt);
      void promise;
    }
    return receipts.sort((a, b) => compareNames(a.name, b.name));
  }

  private readonly loadedValues = new Map<string, LoadedSource>();

  private load(name: string): Promise<LoadedSource> {
    const existing = this.loaded.get(name);
    if (existing !== undefined) return existing;
    const source = this.sourceByName.get(name);
    if (source === undefined) return Promise.reject(new FlowImportProviderError(
      "ImportSourceReadError", `IMPORT source "${name}" is not supplied.`
    ));
    const promise = this.readSource(source).then((value) => {
      this.loadedValues.set(name, value);
      return value;
    });
    this.loaded.set(name, promise);
    return promise;
  }

  private async readSource(source: ImportSourceInput): Promise<LoadedSource> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      const pathStat = await fs.promises.lstat(source.absolutePath);
      if (!pathStat.isFile()) throw new FlowImportProviderError(
        "ImportSourceNotRegularFileError", `IMPORT source "${source.name}" is not a regular file.`
      );
      handle = await fs.promises.open(source.absolutePath, "r");
      const handleStat = await handle.stat();
      if (!handleStat.isFile()) throw new FlowImportProviderError(
        "ImportSourceNotRegularFileError", `IMPORT source "${source.name}" is not a regular file.`
      );
      const buffer = Buffer.allocUnsafe(MAX_IMPORT_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, offset);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (source.expectedSha256 !== undefined && !hashesEqual(sha256, source.expectedSha256)) {
        throw new InputFileMutatedError(source.name);
      }
      const required = this.requiredByName.get(source.name);
      const receipt: InputFileReceipt = {
        name: source.name,
        sha256,
        bytes: bytes.byteLength,
        ...(required?.encoding !== undefined ? { encoding: required.encoding } : {}),
      };
      return { payload: { bytes }, receipt };
    } catch (error) {
      if (error instanceof FlowImportProviderError || error instanceof InputFileMutatedError) throw error;
      throw new FlowImportProviderError(
        "ImportSourceReadError", `IMPORT source "${source.name}" could not be read.`
      );
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }
}

function hashesEqual(actual: string, expected: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
