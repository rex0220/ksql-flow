import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface AtomicWriteOptions {
  open?: typeof fs.promises.open;
  rename?: typeof fs.promises.rename;
  unlink?: typeof fs.promises.unlink;
}

/** Write beside the target, flush, close, then atomically rename without delete-and-retry fallback. */
export async function atomicWriteExportFile(
  targetPath: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const open = options.open ?? fs.promises.open;
  const rename = options.rename ?? fs.promises.rename;
  const unlink = options.unlink ?? fs.promises.unlink;
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle: fs.promises.FileHandle | null = null;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    let offset = 0;
    while (offset < data.byteLength) {
      const result = await handle.write(data, offset, data.byteLength - offset, offset);
      if (result.bytesWritten <= 0) throw new Error("CSV temporary file write made no progress");
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, targetPath);
    renamed = true;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Cleanup errors must not replace the primary failure.
      }
    }
    if (!renamed) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The file may not have been created; preserve the primary failure.
      }
    }
  }
}
