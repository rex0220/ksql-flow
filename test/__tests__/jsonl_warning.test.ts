import * as fs from "fs";
import * as path from "path";
import { JsonlLogger, PendingQueue } from "../../src/logging/jsonl";
import { SecretMasker } from "../../src/logging/mask";
import { buildWorld, TestWorld } from "../helpers/world";

describe("JSONL / 再送キューの best-effort 警告", () => {
  let world: TestWorld;

  afterEach(() => {
    world?.cleanup();
  });

  test("append 失敗は stderr へ認証情報を含まない警告を同一インスタンスで 1 回だけ出す", () => {
    world = buildWorld();
    const masker = new SecretMasker(world.profile);
    const localDir = path.join(world.dir, "jsonl-warning");
    const logger = new JsonlLogger(localDir, "batch-id", world.profile.name, masker);
    fs.mkdirSync(path.join(localDir, "batch-id.jsonl"));
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      logger.append("event", { secret: "token-orders" });
      logger.append("event", { secret: "token-orders" });
      expect(error).toHaveBeenCalledTimes(1);
      const warning = error.mock.calls.flat().join("\n");
      expect(warning).toContain("ローカル JSONL ログへの書き込みに失敗");
      expect(warning).not.toContain("token-orders");
    } finally {
      error.mockRestore();
    }
  });

  test("enqueue 失敗は stderr へ認証情報を含まない警告を同一インスタンスで 1 回だけ出す", () => {
    world = buildWorld();
    const masker = new SecretMasker(world.profile);
    const localDir = path.join(world.dir, "queue-warning");
    fs.mkdirSync(localDir);
    fs.writeFileSync(path.join(localDir, "pending"), "not a directory");
    const queue = new PendingQueue(localDir, masker);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const op = {
      op: "insert" as const,
      fields: { secret: "token-orders" },
      createdAt: new Date().toISOString(),
    };

    try {
      queue.enqueue(op);
      queue.enqueue(op);
      expect(error).toHaveBeenCalledTimes(1);
      const warning = error.mock.calls.flat().join("\n");
      expect(warning).toContain("ログ再送キューへの書き込みに失敗");
      expect(warning).not.toContain("token-orders");
    } finally {
      error.mockRestore();
    }
  });
});
