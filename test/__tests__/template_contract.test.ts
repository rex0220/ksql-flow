import * as path from "path";
import { LOG_APP_FIELDS } from "../../src/logapp";

const AdmZip = require("adm-zip") as new (file: string) => {
  getEntry(name: string): { getData(): Buffer } | null;
};

describe("配布ログアプリテンプレート契約", () => {
  test("template.json の code/type/unique/options が LOG_APP_FIELDS と一致する", () => {
    const zip = new AdmZip(path.resolve("template/ksql-flow-log-template1.zip"));
    const entry = zip.getEntry("01/template.json");
    expect(entry).not.toBeNull();
    const template = JSON.parse(entry!.getData().toString("utf8")) as any;
    const fields = Object.values(template.apps[0].schema.table.fieldList) as any[];
    const byCode = new Map(fields.filter((field) => LOG_APP_FIELDS[field.var] !== undefined).map((field) => [field.var, field]));
    expect([...byCode.keys()].sort()).toEqual(Object.keys(LOG_APP_FIELDS).sort());

    const templateType: Record<string, string> = {
      SINGLE_SELECT: "DROP_DOWN",
      SINGLE_LINE_TEXT: "SINGLE_LINE_TEXT",
      DATETIME: "DATETIME",
      DECIMAL: "NUMBER",
      MULTIPLE_LINE_TEXT: "MULTI_LINE_TEXT",
    };
    for (const [code, expected] of Object.entries(LOG_APP_FIELDS)) {
      const actual = byCode.get(code);
      expect(templateType[actual.type]).toBe(expected.type);
      expect(actual.properties.unique === "true").toBe(expected.unique === true);
      if (expected.options !== undefined) {
        expect(actual.properties.options.map((option: any) => option.label).sort()).toEqual([...expected.options].sort());
      }
    }
  });
});
