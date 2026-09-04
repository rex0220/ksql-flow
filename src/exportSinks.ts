import * as crypto from "crypto";
import * as path from "path";
import {
  createExecutionContext,
  disposeExecutionContext,
  exportSinkStatus,
  serializeCsvExport,
  serializeExportSink,
  serializeSelectResultAsCsv,
  type ExecutionContext,
  type FlowCsvExportOptions,
  type FlowCsvExportReceipt,
  type FlowImportSourceResolver,
  type FlowKintoneClient,
  type ScriptHeaderMeta,
  type Statement,
  type StatementResult,
} from "@rex0220/kintone-sql-tools/flow";
import { atomicWriteExportFile } from "./exportFiles";
import { createShiftJisEncoder } from "./shiftJisEncoder";

export type ExportEncoding = "utf8" | "sjis";

export interface ExportSinkInput {
  readonly name: string;
  readonly sinkName?: string;
  readonly targetPath: string;
}

export interface ExportOutputOptions {
  readonly inputs: readonly ExportSinkInput[];
  readonly encoding: ExportEncoding;
  readonly timezone?: string;
}

export interface OutputFileReceipt {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly encoding: ExportEncoding;
}

interface SerializedExportArtifact {
  readonly input: ExportSinkInput;
  readonly data: Uint8Array;
  readonly receipt: FlowCsvExportReceipt;
  readonly sha256: string;
}

export class ExportOptionError extends Error {
  readonly exitCode = 1;
}

export function hasExportEngineCapability(): boolean {
  return typeof serializeCsvExport === "function"
    && typeof serializeSelectResultAsCsv === "function"
    && typeof serializeExportSink === "function"
    && typeof exportSinkStatus === "function";
}

export function parseExportOutputs(
  values: readonly string[],
  encodingValue?: string,
  timezoneValue?: string,
  resultJson?: string,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform
): ExportOutputOptions | undefined {
  if (values.length === 0) {
    if (encodingValue !== undefined || timezoneValue !== undefined) {
      throw new ExportOptionError("--export-encoding / --export-timezone には --export-csv が必要です");
    }
    return undefined;
  }
  const encoding = encodingValue ?? "utf8";
  if (encoding !== "utf8" && encoding !== "sjis") {
    throw new ExportOptionError("--export-encoding は utf8 または sjis を指定してください");
  }
  if (timezoneValue !== undefined) validateTimezone(timezoneValue);

  const inputs = values.map((value): ExportSinkInput => {
    const separator = value.indexOf("=");
    if (separator < 0) {
      return { name: "select", targetPath: validateTargetPath(value, cwd) };
    }
    const name = value.slice(0, separator);
    const receivedPath = value.slice(separator + 1);
    if (name.length === 0 || name.startsWith("#") || hasControl(name)) {
      throw new ExportOptionError("--export-csv のsink名が不正です");
    }
    return { name, sinkName: name, targetPath: validateTargetPath(receivedPath, cwd) };
  });

  const named = inputs.filter((item) => item.sinkName !== undefined);
  if (named.length !== 0 && named.length !== inputs.length) {
    throw new ExportOptionError("名前付きと名前なしの --export-csv は併用できません");
  }
  if (named.length === 0 && inputs.length !== 1) {
    throw new ExportOptionError("名前なし --export-csv は1件だけ指定できます");
  }
  rejectDuplicates(named.map((item) => item.name), "export sink名", false);
  rejectDuplicates(inputs.map((item) => item.targetPath), "export出力先", platform === "win32");
  if (resultJson !== undefined && resultJson !== "-") {
    const resolvedResult = path.resolve(cwd, resultJson);
    const equal = (left: string, right: string) => platform === "win32"
      ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
      : left === right;
    if (inputs.some((item) => equal(item.targetPath, resolvedResult))) {
      throw new ExportOptionError("--result-json と --export-csv の出力先は同じpathにできません");
    }
  }
  return { inputs, encoding, ...(timezoneValue !== undefined ? { timezone: timezoneValue } : {}) };
}

function validateTargetPath(value: string, cwd: string): string {
  if (value.length === 0 || value === "-" || value.includes("\0")) {
    throw new ExportOptionError("--export-csv の出力pathが不正です");
  }
  return path.resolve(cwd, value);
}

function validateTimezone(value: string): void {
  if (value.length === 0 || value.includes("\0")) throw new ExportOptionError("--export-timezone が不正です");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
  } catch {
    throw new ExportOptionError("--export-timezone は有効なIANA timezoneを指定してください");
  }
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || point === 0x7f;
  });
}

function rejectDuplicates(values: readonly string[], label: string, caseInsensitive: boolean): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = caseInsensitive ? value.toLocaleLowerCase("en-US") : value;
    if (seen.has(key)) throw new ExportOptionError(`${label}が重複しています`);
    seen.add(key);
  }
}

export class ExportSinkRegistry {
  private serialized: SerializedExportArtifact[] = [];
  private readonly completed: OutputFileReceipt[] = [];

  constructor(
    readonly options: ExportOutputOptions,
    statements: readonly Statement[],
    private readonly writer: (targetPath: string, data: Uint8Array) => Promise<void> = atomicWriteExportFile
  ) {
    if (this.isSingleSelect() && (statements.length !== 1 || statements[0]?.type !== "SELECT")) {
      throw new ExportOptionError("名前なし --export-csv は単文SELECTでのみ使用できます");
    }
  }

  flowDeclarations(): Array<{ name: string }> | undefined {
    const declarations = this.options.inputs
      .filter((input): input is ExportSinkInput & { sinkName: string } => input.sinkName !== undefined)
      .map((input) => ({ name: input.sinkName }));
    return declarations.length > 0 ? declarations : undefined;
  }

  /** Ask the engine to validate named declarations synchronously before locks, APIs, or output files. */
  async preflight(
    client: FlowKintoneClient,
    statements: readonly Statement[],
    meta: ScriptHeaderMeta,
    importSource?: FlowImportSourceResolver
  ): Promise<void> {
    if (!hasExportEngineCapability()) {
      throw new ExportOptionError("CSV EXPORTにはengine v3.77.0以降の公開 /flow APIが必要です");
    }
    const declarations = this.flowDeclarations();
    if (declarations === undefined) return;
    const context = createExecutionContext({
      client,
      statements,
      meta,
      exportSinks: declarations,
      ...(importSource !== undefined ? { enableImport: true, importSource } : {}),
    });
    await disposeExecutionContext(context);
  }

  serialize(context: ExecutionContext, statementResults: readonly StatementResult[]): void {
    if (!hasExportEngineCapability()) {
      throw new ExportOptionError("CSV EXPORTにはengine v3.77.0以降の公開 /flow APIが必要です");
    }
    const csvOptions: FlowCsvExportOptions = {
      encoding: this.options.encoding,
      ...(this.options.timezone !== undefined ? { timezone: this.options.timezone } : {}),
      ...(this.options.encoding === "sjis" ? { encoder: createShiftJisEncoder() } : {}),
    };
    const materialized: ExportSinkInput[] = [];
    for (const input of this.options.inputs) {
      if (input.sinkName === undefined) continue;
      const status = exportSinkStatus(context, input.sinkName);
      if (status === "materialized") materialized.push(input);
      else if (status !== "not-created") throw new Error(`export sink ${input.name} is ${status}`);
    }
    const artifacts: SerializedExportArtifact[] = [];
    if (this.isSingleSelect()) {
      const result = serializeSelectResultAsCsv(statementResults[0]!, csvOptions);
      artifacts.push(this.toArtifact(this.options.inputs[0]!, result));
    } else {
      for (const input of materialized) {
        const result = serializeExportSink(context, input.sinkName!, csvOptions);
        artifacts.push(this.toArtifact(input, result));
      }
    }
    this.serialized = artifacts;
  }

  async commit(): Promise<void> {
    for (const artifact of this.serialized) {
      if (artifact.receipt.bytes !== artifact.data.byteLength) {
        throw new Error("CSV receipt byte count does not match serialized data");
      }
      await this.writer(artifact.input.targetPath, artifact.data);
      this.completed.push({
        name: artifact.input.name,
        sha256: artifact.sha256,
        bytes: artifact.data.byteLength,
        rows: artifact.receipt.rows,
        encoding: artifact.receipt.encoding,
      });
    }
  }

  snapshotOutputFiles(): OutputFileReceipt[] {
    return this.completed.map((item) => ({ ...item }));
  }

  private isSingleSelect(): boolean {
    return this.options.inputs[0]?.sinkName === undefined;
  }

  private toArtifact(
    input: ExportSinkInput,
    result: { data: Uint8Array; receipt: FlowCsvExportReceipt }
  ): SerializedExportArtifact {
    return {
      input,
      data: result.data,
      receipt: result.receipt,
      sha256: crypto.createHash("sha256").update(result.data).digest("hex"),
    };
  }
}
