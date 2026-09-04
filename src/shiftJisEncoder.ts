import Encoding from "encoding-japanese";
import type { FlowExportTextEncoder } from "@rex0220/kintone-sql-tools/flow";

export class ShiftJisEncodingError extends Error {
  readonly code = "ExportSinkEncodingError";

  constructor(message: string) {
    super(`ExportSinkEncodingError: ${message}`);
    this.name = "ExportSinkEncodingError";
  }
}

function firstMismatch(expected: string, actual: string): number {
  const length = Math.min(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    if (expected.charCodeAt(index) !== actual.charCodeAt(index)) return index;
  }
  return length;
}

function codePointAt(text: string, offset: number): string {
  const point = text.codePointAt(offset) ?? 0xfffd;
  return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** CP932 encoder that fails closed when the canonical Unicode text cannot round-trip exactly. */
export function createShiftJisEncoder(): FlowExportTextEncoder {
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  return {
    encoding: "sjis",
    encode(text: string): Uint8Array {
      const converted = Encoding.convert(Encoding.stringToCode(text), {
        to: "SJIS",
        from: "UNICODE",
      });
      if (!Array.isArray(converted) || converted.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new ShiftJisEncodingError("the encoder returned invalid byte data");
      }
      const bytes = new Uint8Array(converted);
      let decoded: string;
      try {
        decoded = decoder.decode(bytes);
      } catch {
        throw new ShiftJisEncodingError("the encoded bytes could not be decoded for verification");
      }
      if (decoded !== text) {
        const offset = firstMismatch(text, decoded);
        throw new ShiftJisEncodingError(
          `character ${codePointAt(text, offset)} at offset ${offset} cannot be represented in Shift_JIS`
        );
      }
      return bytes;
    },
  };
}
