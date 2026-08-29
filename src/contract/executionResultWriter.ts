import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { ExecutionResult } from "./executionResult";

export type ExecutionResultDestination = string;

export type ExecutionResultFileSystem = Pick<
  typeof fs,
  "existsSync" | "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync"
>;

/**
 * Execution Result を stdout または同一ディレクトリ内の一時ファイル経由で出力する。
 * JSON は常に object 1 個 + LF とし、ファイルは fsync 後に完成名へ置換する。
 */
export function writeExecutionResult(
  destination: ExecutionResultDestination,
  result: ExecutionResult,
  stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  fileSystem: ExecutionResultFileSystem = fs
): void {
  const json = `${JSON.stringify(result)}\n`;
  if (destination === "-") {
    stdout.write(json, "utf8");
    return;
  }

  const target = path.resolve(destination);
  if (fileSystem.existsSync(target)) {
    throw new Error(`Execution Result の出力先は既に存在します: ${destination}`);
  }

  const directory = path.dirname(target);
  const basename = path.basename(target);
  const temporary = path.join(
    directory,
    `.${basename}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  let descriptor: number | null = null;
  try {
    descriptor = fileSystem.openSync(temporary, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, json, { encoding: "utf8" });
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;

    // Windows の rename 上書き可否に依存せず、開始後に生成された出力先も拒否する。
    if (fileSystem.existsSync(target)) {
      throw new Error(`Execution Result の出力先は既に存在します: ${destination}`);
    }
    fileSystem.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        /* 元の書込エラーを維持する */
      }
    }
    try {
      fileSystem.unlinkSync(temporary);
    } catch {
      /* rename 済み、または一時ファイル未作成 */
    }
    throw error;
  }
}
