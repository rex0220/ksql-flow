import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StateStore } from "../../src/state";

describe("state public contract", () => {
  test.each([
    ["未知 schemaVersion", JSON.stringify({ schemaVersion: 99 })],
    ["破損 JSON", "{ broken"],
  ])("%s は警告して null fallback", (_case, content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-state-"));
    const stateDir = path.join(dir, ".ksql");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, "state-prod.json"), content);
    const warnings: string[] = [];
    try {
      expect(new StateStore(dir, "prod", (line) => warnings.push(line)).read()).toBeNull();
      expect(warnings.join("\n")).toContain("警告");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
