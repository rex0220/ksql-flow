import * as path from "path";
import { validateCommand } from "../../src/commands/validate";
import { EXIT } from "../../src/types";
import { buildWorld, TestWorld } from "../helpers/world";

jest.setTimeout(30000);

let world: TestWorld;

afterEach(() => {
  world?.cleanup();
});

describe("examples/jobs のサンプルが有効な dialect 1 スクリプトであること", () => {
  test("validate-all が Exit 0", async () => {
    world = buildWorld({});
    const examplesDir = path.join(__dirname, "..", "..", "examples", "jobs");
    const lines: string[] = [];
    const code = await validateCommand(world.profile, { dir: examplesDir }, {
      baseFetch: world.mock.fetch,
      out: (line) => lines.push(line),
    });
    expect(lines.join("\n")).not.toMatch(/error/);
    expect(code).toBe(EXIT.OK);
  });
});
