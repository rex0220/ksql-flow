import { createHttpLayer } from "../../src/http";
import { ApiLimitError, HttpRetryExhaustedError } from "../../src/errors";
import { DEFAULT_RETRY } from "../../src/config";

function jsonResponse(status: number, headers?: Record<string, string>): Response {
  return new Response("{}", { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("HTTP 層（設計書 7 章）", () => {
  test("dry-run ガードは変更系 API を下位 fetch 前に遮断し cursor 読取は許可する", async () => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { ...DEFAULT_RETRY, maxAttempts: 1 },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      dryRun: true,
      baseFetch: (async () => {
        calls += 1;
        return jsonResponse(200);
      }) as typeof fetch,
    });
    for (const method of ["POST", "PUT", "DELETE"]) {
      await expect(
        layer.fetch("https://example.cybozu.com/k/v1/records.json", { method })
      ).rejects.toThrow("副作用ゼロガード");
    }
    await expect(
      layer.fetch("https://example.cybozu.com/k/guest/123/v1/records.json", { method: "POST" })
    ).rejects.toThrow("副作用ゼロガード");
    expect(calls).toBe(0);
    expect(layer.count).toBe(0);

    await layer.fetch("https://example.cybozu.com/k/v1/records/cursor.json", { method: "POST" });
    await layer.fetch("https://example.cybozu.com/k/v1/records/cursor.json", { method: "DELETE" });
    expect(calls).toBe(2);
  });

  test("429 は Retry-After を尊重してリトライする", async () => {
    const delays: number[] = [];
    let calls = 0;
    const layer = createHttpLayer({
      retry: { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 60000, respectRetryAfter: true },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      baseFetch: (async () => {
        calls += 1;
        return calls < 3 ? jsonResponse(429, { "Retry-After": "7" }) : jsonResponse(200);
      }) as typeof fetch,
    });
    const response = await layer.fetch("https://example.cybozu.com/k/v1/records.json");
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(delays).toEqual([7000, 7000]); // Retry-After: 7 秒
    expect(layer.count).toBe(3); // リトライの各試行も計上
  });

  test("5xx は指数バックオフでリトライし、上限超過で HttpRetryExhaustedError (Exit 3)", async () => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, respectRetryAfter: true },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      sleep: async () => undefined,
      baseFetch: (async () => {
        calls += 1;
        return jsonResponse(503);
      }) as typeof fetch,
    });
    await expect(layer.fetch("https://example.com/x")).rejects.toThrow(HttpRetryExhaustedError);
    expect(calls).toBe(3);
  });

  test.each([504, 522])("HTTP %i は一時エラーとしてリトライする", async (status) => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 10, respectRetryAfter: true },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      sleep: async () => undefined,
      baseFetch: (async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(status) : jsonResponse(200);
      }) as typeof fetch,
    });
    await expect(layer.fetch("https://example.com/x")).resolves.toHaveProperty("status", 200);
    expect(calls).toBe(2);
  });

  test("HTTP 501 はリトライしない", async () => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { ...DEFAULT_RETRY, maxAttempts: 5 },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      sleep: async () => undefined,
      baseFetch: (async () => {
        calls += 1;
        return jsonResponse(501);
      }) as typeof fetch,
    });
    const response = await layer.fetch("https://example.com/x");
    expect(response.status).toBe(501);
    expect(calls).toBe(1);
  });

  test("401 / 403（認証エラー）はリトライしない", async () => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { ...DEFAULT_RETRY, maxAttempts: 5 },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      sleep: async () => undefined,
      baseFetch: (async () => {
        calls += 1;
        return jsonResponse(401);
      }) as typeof fetch,
    });
    const response = await layer.fetch("https://example.com/x");
    expect(response.status).toBe(401); // 即座に返す（エンジン側が KintoneHttpError にする）
    expect(calls).toBe(1);
  });

  test("ネットワークエラーもリトライ対象", async () => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 10, respectRetryAfter: true },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      sleep: async () => undefined,
      baseFetch: (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return jsonResponse(200);
      }) as typeof fetch,
    });
    const response = await layer.fetch("https://example.com/x");
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("maxApiCalls 到達後のリクエストは発行前に ApiLimitError で止まる", async () => {
    let calls = 0;
    const layer = createHttpLayer({
      retry: { ...DEFAULT_RETRY, maxAttempts: 1 },
      maxApiCalls: 2,
      attemptTimeoutMs: 1000,
      sleep: async () => undefined,
      baseFetch: (async () => {
        calls += 1;
        return jsonResponse(200);
      }) as typeof fetch,
    });
    await layer.fetch("https://example.com/1");
    await layer.fetch("https://example.com/2");
    await expect(layer.fetch("https://example.com/3")).rejects.toThrow(ApiLimitError);
    expect(calls).toBe(2); // 3 回目は発行されない
  });

  test("Basic 認証の併送（設計書 9.1）", async () => {
    let authHeader: string | null = null;
    const layer = createHttpLayer({
      retry: { ...DEFAULT_RETRY, maxAttempts: 1 },
      maxApiCalls: null,
      attemptTimeoutMs: 1000,
      basicAuth: { username: "basic-user", password: "basic-pass" },
      baseFetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        authHeader = new Headers(init?.headers).get("Authorization");
        return jsonResponse(200);
      }) as typeof fetch,
    });
    await layer.fetch("https://example.com/x");
    expect(authHeader).toBe(`Basic ${Buffer.from("basic-user:basic-pass").toString("base64")}`);
  });
});
