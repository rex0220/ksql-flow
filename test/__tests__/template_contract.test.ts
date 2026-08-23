import * as path from "path";
import { LOG_APP_FIELDS, OPTIONAL_LOG_APP_FIELD_CODES } from "../../src/logapp";

const AdmZip = require("adm-zip") as new (file: string) => {
  getEntry(name: string): { getData(): Buffer } | null;
};

describe("配布ログアプリテンプレート契約", () => {
  test("旧 template.json が必須 field/type/unique/options を満たす", () => {
    const zip = new AdmZip(path.resolve("template/ksql-flow-log-template1.zip"));
    const entry = zip.getEntry("01/template.json");
    expect(entry).not.toBeNull();
    const template = JSON.parse(entry!.getData().toString("utf8")) as any;
    const fields = Object.values(template.apps[0].schema.table.fieldList) as any[];
    const byCode = new Map(fields.filter((field) => LOG_APP_FIELDS[field.var] !== undefined).map((field) => [field.var, field]));
    // 同梱テンプレート(v0.3+)は任意フィールド(deleted_count)も含む完全形。
    // 「任意」の緩和は旧テンプレート製の既存アプリ(check-logapp / 実行時判定)向けであり、
    // 配布物自体は全フィールドを持つことを契約とする
    expect([...byCode.keys()].sort()).toEqual(Object.keys(LOG_APP_FIELDS).sort());
    expect([...OPTIONAL_LOG_APP_FIELD_CODES].every((code) => byCode.has(code))).toBe(true);

    const templateType: Record<string, string> = {
      SINGLE_SELECT: "DROP_DOWN",
      SINGLE_LINE_TEXT: "SINGLE_LINE_TEXT",
      DATETIME: "DATETIME",
      DECIMAL: "NUMBER",
      MULTIPLE_LINE_TEXT: "MULTI_LINE_TEXT",
    };
    for (const [code, expected] of Object.entries(LOG_APP_FIELDS)) {
      const actual = byCode.get(code);
      if (actual === undefined && OPTIONAL_LOG_APP_FIELD_CODES.has(code)) continue;
      expect(templateType[actual.type]).toBe(expected.type);
      expect(actual.properties.unique === "true").toBe(expected.unique === true);
      if (expected.options !== undefined) {
        expect(actual.properties.options.map((option: any) => option.label).sort()).toEqual([...expected.options].sort());
      }
    }
  });
});
