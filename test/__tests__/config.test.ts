import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, appIdMap, tokenByAppId } from "../../src/config";
import { ConfigError } from "../../src/errors";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ksql-flow-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  const file = path.join(dir, "ksql.config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

const BASE = {
  defaultProfile: "prod",
  profiles: {
    prod: {
      baseUrl: "https://example.cybozu.com",
      timezone: "Asia/Tokyo",
      apps: {
        受注: { id: 100, tokens: ["token-orders"] },
        実行ログ: { id: 999, tokens: ["token-logs"] },
      },
      logApp: "実行ログ",
    },
  },
};

describe("loadConfig", () => {
  test("基本の読込と defaultProfile", () => {
    const profile = loadConfig({ configPath: writeConfig(BASE) });
    expect(profile.name).toBe("prod");
    expect(profile.baseUrl).toBe("https://example.cybozu.com");
    expect(profile.timezone).toBe("Asia/Tokyo");
    expect(appIdMap(profile)).toEqual({ 受注: 100, 実行ログ: 999 });
    expect(profile.logApp).toBe("実行ログ");
    // 既定値
    expect(profile.retry.maxAttempts).toBe(5);
    expect(profile.limits.batchTimeoutSec).toBe(3600);
    expect(profile.limits.maxReadRows).toBeNull();
  });

  test.each([1, 200000])("limits.maxReadRows の境界値 %i を受理する", (maxReadRows) => {
    const config = structuredClone(BASE) as Record<string, any>;
    config.profiles.prod.limits = { maxReadRows };
    expect(loadConfig({ configPath: writeConfig(config) }).limits.maxReadRows).toBe(maxReadRows);
  });

  test.each([0, 200001, 1.5, "100"])("limits.maxReadRows の不正値 %p を拒否する", (maxReadRows) => {
    const config = structuredClone(BASE) as Record<string, any>;
    config.profiles.prod.limits = { maxReadRows };
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(ConfigError);
  });

  test.each([
    ["top-level", (config: any) => { config.unexpected = true; }],
    ["profile", (config: any) => { config.profiles.prod.unexpected = true; }],
    ["apps entry", (config: any) => { config.profiles.prod.apps.受注.unexpected = true; }],
    ["limits", (config: any) => { config.limits = { maxApiCalls: 10, unexpected: true }; }],
    ["retry", (config: any) => { config.retry = { maxAttempts: 2, unexpected: true }; }],
    ["notifications", (config: any) => { config.notifications = { onFailure: { webhook: "x", unexpected: true } }; }],
    ["logging", (config: any) => { config.logging = { stripLiterals: false, unexpected: true }; }],
    ["auth", (config: any) => { config.profiles.prod.auth = { type: "apiToken", unexpected: true }; }],
  ])("未知キーを ConfigError にする: %s", (_layer, mutate) => {
    const config = structuredClone(BASE) as any;
    mutate(config);
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/未知の設定キー/);
  });

  test("stripLiterals の typo を拒否する", () => {
    const config = structuredClone(BASE) as any;
    config.profiles.prod.logging = { stripLiteral: true };
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/stripLiteral.*未知の設定キー/);
  });

  test("設定ファイルが無ければ ConfigError", () => {
    expect(() => loadConfig({ configPath: path.join(dir, "nope.json") })).toThrow(ConfigError);
  });

  test("env: 参照の解決と未定義エラー", () => {
    process.env.KSQL_TEST_TOKEN = "resolved-token";
    try {
      const config = structuredClone(BASE) as typeof BASE;
      config.profiles.prod.apps.受注.tokens = ["env:KSQL_TEST_TOKEN"];
      const profile = loadConfig({ configPath: writeConfig(config) });
      expect(profile.apps["受注"].tokens).toEqual(["resolved-token"]);

      delete process.env.KSQL_TEST_TOKEN;
      expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/KSQL_TEST_TOKEN/);
    } finally {
      delete process.env.KSQL_TEST_TOKEN;
    }
  });

  test.each([
    ["notifications.onFailure.webhook", { notifications: { onFailure: { webhook: "env:KSQL_MISSING_WEBHOOK" } } }],
    ["notifications.heartbeat.url", { notifications: { heartbeat: { url: "env:KSQL_MISSING_HEARTBEAT" } } }],
    ["proxy", { proxy: "env:KSQL_MISSING_PROXY" }],
  ])("明記された未解決 env 参照は黙って無効化しない: %s", (_label, patch) => {
    delete process.env.KSQL_MISSING_WEBHOOK;
    delete process.env.KSQL_MISSING_HEARTBEAT;
    delete process.env.KSQL_MISSING_PROXY;
    const config = structuredClone(BASE) as Record<string, any>;
    Object.assign(config.profiles.prod, patch);
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/環境変数 KSQL_MISSING_/);
  });

  test.each([
    ["clientCert", { clientCert: { pfxPath: "client.pfx", password: "secret" } }],
    ["proxy", { proxy: "http://proxy.example.com:8080" }],
  ])("未対応の接続設定 %s は ConfigError で停止する", (_label, patch) => {
    const config = structuredClone(BASE) as Record<string, any>;
    Object.assign(config.profiles.prod, patch);
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/未対応.*設定を削除/);
  });

  test("extends は接続設定を継承するが apps / logApp は継承しない（設計書 9 章）", () => {
    const config = {
      defaultProfile: "prod",
      profiles: {
        prod: { ...BASE.profiles.prod, timezone: "Asia/Tokyo" },
        stg: {
          extends: "prod",
          baseUrl: "https://stg.cybozu.com",
          apps: { 受注: { id: 310, tokens: ["stg-token"] } },
        },
      },
    };
    const stg = loadConfig({ configPath: writeConfig(config), profile: "stg" });
    expect(stg.baseUrl).toBe("https://stg.cybozu.com");
    expect(stg.timezone).toBe("Asia/Tokyo"); // 継承される
    expect(appIdMap(stg)).toEqual({ 受注: 310 }); // prod の 実行ログ は継承されない
    expect(stg.logApp).toBeUndefined(); // logApp も継承されない
  });

  test("extends の循環はエラー", () => {
    const config = {
      defaultProfile: "a",
      profiles: {
        a: { extends: "b", baseUrl: "https://a.example.com" },
        b: { extends: "a", baseUrl: "https://b.example.com" },
      },
    };
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/循環/);
  });

  test("logApp が apps に無ければエラー", () => {
    const config = structuredClone(BASE) as { profiles: { prod: { logApp: string } } };
    config.profiles.prod.logApp = "存在しない";
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/logApp/);
  });

  test("トークン 10 個以上はエラー（kintone 上限 9 個）", () => {
    const config = structuredClone(BASE) as typeof BASE;
    config.profiles.prod.apps.受注.tokens = Array.from({ length: 10 }, (_, index) => `t${index}`);
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/最大 9 個/);
  });

  test("timezone が不正ならエラー", () => {
    const config = structuredClone(BASE) as typeof BASE;
    config.profiles.prod.timezone = "Japan/Osaka" as never;
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/timezone/);
  });

  test("tokenByAppId は対象アプリのトークンのみカンマ結合で返す（設計書 9.1）", () => {
    const config = structuredClone(BASE) as typeof BASE;
    config.profiles.prod.apps.受注.tokens = ["read-token", "write-token"];
    const profile = loadConfig({ configPath: writeConfig(config) });
    const resolve = tokenByAppId(profile);
    expect(resolve(100)).toBe("read-token,write-token");
    expect(resolve(999)).toBe("token-logs");
    expect(() => resolve(12345)).toThrow(/12345/);
  });

  test("プロファイル未指定・defaultProfile 無しはエラー", () => {
    const config = { profiles: { prod: BASE.profiles.prod } };
    expect(() => loadConfig({ configPath: writeConfig(config) })).toThrow(/プロファイル/);
  });
});
