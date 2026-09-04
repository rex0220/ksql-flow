import Encoding from "encoding-japanese";
import { createShiftJisEncoder, ShiftJisEncodingError } from "../../src/shiftJisEncoder";

describe("Shift_JIS export encoder", () => {
  test.each(["ASCII", "日本語", "ｶﾅ", "①", "Ⅰ", "髙", "﨑", "～"])(
    "matches encoding-japanese bytes for %s",
    (text) => {
      const actual = createShiftJisEncoder().encode(text);
      const expected = new Uint8Array(
        Encoding.convert(Encoding.stringToCode(text), { to: "SJIS", from: "UNICODE" })
      );
      expect(actual).toEqual(expected);
      expect(new TextDecoder("shift_jis", { fatal: true }).decode(actual)).toBe(text);
    }
  );

  test.each(["波形〜", "円¥", "負−", "罫—", "emoji😀", "한글"])(
    "fails closed without including the cell text: %s",
    (text) => {
      let thrown: unknown;
      try {
        createShiftJisEncoder().encode(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ShiftJisEncodingError);
      const message = (thrown as Error).message;
      expect(message).toMatch(/U\+[0-9A-F]{4,6} at offset \d+/);
      expect(message).not.toContain(text);
    }
  );
});
