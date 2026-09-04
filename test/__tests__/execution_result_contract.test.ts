import * as fs from "fs";
import * as path from "path";
import Ajv2020 from "ajv/dist/2020";
import {
  EXECUTION_CONTRACT,
  EXECUTION_ERROR_MESSAGE_MAX_LENGTH,
  normalizeJobOutcome,
  type ExecutionErrorCategory,
  type ExecutionResult,
  type NormalizeExecutionResultContext,
  type RuntimeFailureKind,
} from "../../src/contract";
import { HttpRetryExhaustedError, LockUnavailableError } from "../../src/errors";
import { EXIT, type JobOutcome, type JobStatus } from "../../src/types";

const SCHEMA_PATH = path.resolve(__dirname, "../../schema/execution-result-v1.schema.json");
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/execution-result");

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addKeyword("x-contract");
const validate = ajv.compile(schema);

function expectSchemaValid(value: unknown): void {
  expect(validate(value)).toBe(true);
  expect(validate.errors).toBeNull();
}

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function outcome(status: JobStatus, exitCode: JobOutcome["exitCode"], message = "failure detail"): JobOutcome {
  return {
    jobName: "aggregate_customer",
    scriptName: "aggregate_customer.sql",
    status,
    exitCode,
    errorMessage: status === "SUCCESS" || status === "NO_DATA" ? undefined : message,
    startedAt: new Date("2026-08-30T08:00:00.000Z"),
    finishedAt: new Date("2026-08-30T08:00:01.000Z"),
    readCount: 12,
    writtenCount: 7,
    deletedCount: 2,
    apiCalls: 4,
    lastWrittenKey: "C000007",
    detailLines: [],
  };
}

function context(
  executionStarted: boolean,
  failureKind?: RuntimeFailureKind,
  error?: NormalizeExecutionResultContext["error"]
): NormalizeExecutionResultContext {
  return {
    correlationId: "network_run_1",
    attemptId: "attempt_1",
    executionId: "e9df9306-bef0-489f-b721-37c78c01fe54",
    profile: "prod",
    asOf: "2026-08-01T00:00:00+09:00",
    executionStarted,
    startedAt: executionStarted ? new Date("2026-08-30T08:00:00.000Z") : null,
    finishedAt: new Date("2026-08-30T08:00:01.000Z"),
    lastSuccessfulChunkNo: executionStarted ? 3 : null,
    ksqlFlowVersion: "0.6.0",
    engineVersion: "3.74.0",
    inputFiles: [],
    outputFiles: [],
    failureKind,
    error,
    masker: { mask: (value) => value },
  };
}

describe("Execution Result v1 canonical schema", () => {
  test("contains a stable schema id and contract version", () => {
    expect(schema.$id).toBe("https://github.com/rex0220/ksql-flow/blob/main/schema/execution-result-v1.schema.json");
    expect(schema["x-contract"]).toBe(EXECUTION_CONTRACT);
    expect((schema.properties as Record<string, { const?: unknown }>).contract.const).toBe(EXECUTION_CONTRACT);
  });

  test.each(["success.json", "failure.json", "sql-error.json"])(
    "validates the FlowNet c95cbc4 fixture %s",
    (name) => expectSchemaValid(readFixture(name))
  );

  test("keeps resultCode and error.category additive", () => {
    const future = readFixture("failure.json") as ExecutionResult;
    future.resultCode = "FUTURE_FAILURE";
    if (future.error !== null) future.error.category = "FUTURE_CATEGORY" as ExecutionErrorCategory;
    expectSchemaValid(future);
  });

  test("FlowNet 相当の同梱 schema 検証は additive unknown field を受理する", () => {
    const future = readFixture("failure.json") as ExecutionResult & Record<string, unknown>;
    future.futureProducerField = { formatVersion: 2 };
    if (future.error !== null) {
      (future.error as typeof future.error & Record<string, unknown>).futureErrorField = "additive";
    }
    expectSchemaValid(future);
  });

  test("rejects an unknown resultCode when status and Exit are inconsistent", () => {
    const future = readFixture("failure.json") as ExecutionResult;
    future.resultCode = "FUTURE_FAILURE";
    future.status = "SUCCESS";
    expect(validate(future)).toBe(false);
  });
});

describe("JobOutcome to Execution Result normalization", () => {
  test("emits additive input_files with optional rows and encoding", () => {
    const input = context(true);
    input.inputFiles = [{
      name: "sales",
      sha256: "a".repeat(64),
      bytes: 123,
      encoding: "SJIS",
    }];
    const result = normalizeJobOutcome(outcome("SUCCESS", EXIT.OK), input);
    expect(result.input_files).toEqual(input.inputFiles);
    expect(result.input_files[0]).not.toHaveProperty("rows");
    expectSchemaValid(result);
    expect(validate({ ...result, input_files: [{ ...result.input_files[0], path: "C:\\secret.csv" }] })).toBe(false);
  });

  test("emits strict path-free output_files while old v1 fixtures remain valid", () => {
    const input = context(true);
    input.outputFiles = [{
      name: "export",
      sha256: "b".repeat(64),
      bytes: 9,
      rows: 1,
      encoding: "utf8",
    }];
    const result = normalizeJobOutcome(outcome("SUCCESS", EXIT.OK), input);
    expect(result.output_files).toEqual(input.outputFiles);
    expectSchemaValid(result);
    expect(validate({ ...result, output_files: [{ ...result.output_files[0], path: "C:\\secret.csv" }] })).toBe(false);
    expectSchemaValid(readFixture("success.json"));
  });

  test("maps pre-execution sha mismatch to INPUT_FILE_MUTATED", () => {
    const input = context(false);
    input.validationFailureKind = "INPUT_FILE_MUTATED";
    const result = normalizeJobOutcome(outcome("FAILED", EXIT.VALIDATION), input);
    expect(result).toMatchObject({
      resultCode: "INPUT_FILE_MUTATED",
      executionStarted: false,
      exitCode: 1,
      error: { category: "CONFIG", code: "INPUT_FILE_MUTATED" },
    });
    expectSchemaValid(result);
  });

  const rows: Array<{
    label: string;
    outcome: JobOutcome;
    started: boolean;
    failureKind?: RuntimeFailureKind;
    expected: Pick<ExecutionResult, "status" | "resultCode" | "exitCode">;
    category: ExecutionErrorCategory | null;
  }> = [
    { label: "OK", outcome: outcome("SUCCESS", EXIT.OK), started: true, expected: { status: "SUCCESS", resultCode: "OK", exitCode: 0 }, category: null },
    { label: "NO_DATA", outcome: outcome("NO_DATA", EXIT.OK), started: true, expected: { status: "SUCCESS", resultCode: "NO_DATA", exitCode: 0 }, category: null },
    { label: "VALIDATION_ERROR", outcome: outcome("FAILED", EXIT.VALIDATION), started: false, expected: { status: "FAILED", resultCode: "VALIDATION_ERROR", exitCode: 1 }, category: "CONFIG" },
    { label: "SQL_ERROR", outcome: outcome("FAILED", EXIT.VALIDATION), started: true, expected: { status: "FAILED", resultCode: "SQL_ERROR", exitCode: 1 }, category: "SQL" },
    { label: "ASSERT_FAILED", outcome: outcome("ABORTED", EXIT.ABORTED), started: true, expected: { status: "FAILED", resultCode: "ASSERT_FAILED", exitCode: 2 }, category: "ASSERT" },
    { label: "EXECUTION_TIMEOUT", outcome: outcome("TIMEOUT", EXIT.RUNTIME), started: true, expected: { status: "FAILED", resultCode: "EXECUTION_TIMEOUT", exitCode: 3 }, category: "TIMEOUT" },
    { label: "AUTH_ERROR", outcome: outcome("FAILED", EXIT.RUNTIME), started: true, expected: { status: "FAILED", resultCode: "AUTH_ERROR", exitCode: 3 }, category: "AUTH" },
    { label: "API_ERROR", outcome: outcome("FAILED", EXIT.RUNTIME), started: true, expected: { status: "FAILED", resultCode: "API_ERROR", exitCode: 3 }, category: "API" },
    { label: "LOCK_UNAVAILABLE", outcome: outcome("FAILED", EXIT.RUNTIME), started: false, expected: { status: "FAILED", resultCode: "LOCK_UNAVAILABLE", exitCode: 3 }, category: "LOCK" },
    { label: "INTERNAL_ERROR", outcome: outcome("FAILED", EXIT.RUNTIME), started: true, failureKind: "INTERNAL_ERROR", expected: { status: "FAILED", resultCode: "INTERNAL_ERROR", exitCode: 3 }, category: "INTERNAL" },
    { label: "CANCELLED", outcome: outcome("CANCELLED", EXIT.RUNTIME), started: true, expected: { status: "CANCELLED", resultCode: "CANCELLED", exitCode: 3 }, category: "CANCELLED" },
    { label: "LOCK_CONFLICT", outcome: outcome("LOCKED", EXIT.LOCKED), started: false, expected: { status: "FAILED", resultCode: "LOCK_CONFLICT", exitCode: 5 }, category: "LOCK" },
  ];

  test.each(rows)("maps $label", ({ outcome: source, started, failureKind, expected, category }) => {
    const input = context(started, failureKind);
    if (expected.resultCode === "AUTH_ERROR") input.cause = { status: 403 };
    if (expected.resultCode === "API_ERROR") input.cause = new HttpRetryExhaustedError("retry failed");
    if (expected.resultCode === "LOCK_UNAVAILABLE") input.cause = new LockUnavailableError("lock unavailable");
    const result = normalizeJobOutcome(source, input);
    expect(result).toMatchObject(expected);
    expect(result.executionStarted).toBe(started);
    expect(result.error?.category ?? null).toBe(category);
    expectSchemaValid(result);
  });

  test("distinguishes both Exit 1 meanings by resultCode and executionStarted", () => {
    const beforeSql = normalizeJobOutcome(outcome("FAILED", EXIT.VALIDATION), context(false));
    const duringSql = normalizeJobOutcome(outcome("FAILED", EXIT.VALIDATION), context(true));
    expect([beforeSql.resultCode, beforeSql.executionStarted, beforeSql.exitCode]).toEqual([
      "VALIDATION_ERROR",
      false,
      1,
    ]);
    expect([duringSql.resultCode, duringSql.executionStarted, duringSql.exitCode]).toEqual([
      "SQL_ERROR",
      true,
      1,
    ]);
  });

  test("旧 failureKind=CANCELLED 経路も同じ CANCELLED 結果へ正規化する", () => {
    const result = normalizeJobOutcome(outcome("FAILED", EXIT.RUNTIME), context(true, "CANCELLED"));
    expect(result).toMatchObject({ status: "CANCELLED", resultCode: "CANCELLED", exitCode: 3 });
    expectSchemaValid(result);
  });

  test.each([
    ["VALIDATION_ERROR", outcome("FAILED", EXIT.VALIDATION), context(false)],
    ["LOCK_CONFLICT", outcome("LOCKED", EXIT.LOCKED), context(false)],
  ])("schema requires executionStarted=false for %s", (_label, source, input) => {
    const result = normalizeJobOutcome(source as JobOutcome, input as NormalizeExecutionResultContext);
    const invalid = { ...result, executionStarted: true, startedAt: "2026-08-30T08:00:00.000Z" };
    expect(validate(invalid)).toBe(false);
  });

  test("generates all nine initial error categories", () => {
    const categories = new Set(
      rows
        .map(({ outcome: source, started, failureKind, expected }) => {
          const input = context(started, failureKind);
          if (expected.resultCode === "AUTH_ERROR") input.cause = { status: 401 };
          if (expected.resultCode === "API_ERROR") input.cause = new TypeError("network down");
          if (expected.resultCode === "LOCK_UNAVAILABLE") input.cause = new LockUnavailableError("lock unavailable");
          return normalizeJobOutcome(source, input).error?.category;
        })
        .filter((category): category is ExecutionErrorCategory => category !== undefined)
    );
    expect([...categories].sort()).toEqual(
      ["CONFIG", "SQL", "ASSERT", "API", "AUTH", "TIMEOUT", "LOCK", "INTERNAL", "CANCELLED"].sort()
    );
  });

  test("masks and truncates error.message at 2000 characters", () => {
    const secret = "super-secret-token";
    const result = normalizeJobOutcome(
      outcome("FAILED", EXIT.RUNTIME),
      {
        ...context(true, "INTERNAL_ERROR", {
          code: "UNEXPECTED_FAILURE",
          message: `token=${secret};${"x".repeat(2100)}`,
        }),
        masker: { mask: (value) => value.split(secret).join("***") },
      }
    );
    expect(result.error?.message).not.toContain(secret);
    expect(Array.from(result.error?.message ?? "")).toHaveLength(EXECUTION_ERROR_MESSAGE_MAX_LENGTH);
    expect(result.error?.detailsTruncated).toBe(true);
    expect(result.error?.code).toBe("UNEXPECTED_FAILURE");
    expectSchemaValid(result);
  });

  test("preserves an upstream detailsTruncated flag and strips SQL literals", () => {
    const result = normalizeJobOutcome(
      outcome("FAILED", EXIT.VALIDATION),
      context(true, undefined, {
        message: "field lookup failed for 'customer secret' at key 12345",
        detailsTruncated: true,
      })
    );
    expect(result.error?.message).toBe("field lookup failed for ? at key ?");
    expect(result.error?.detailsTruncated).toBe(true);
  });

  test("normalizes unmeasured pre-execution metrics to zero and null", () => {
    const result = normalizeJobOutcome(outcome("FAILED", EXIT.VALIDATION), context(false));
    expect(result).toMatchObject({
      startedAt: null,
      durationMs: 0,
      readCount: 0,
      writtenCount: 0,
      deletedCount: 0,
      apiCalls: 0,
      lastSuccessfulChunkNo: null,
      lastWrittenKey: null,
    });
  });

  test.each([
    [401, "AUTH_ERROR", "KINTONE_HTTP_401"],
    [403, "AUTH_ERROR", "KINTONE_HTTP_403"],
    [429, "API_ERROR", "KINTONE_HTTP_429"],
    [500, "API_ERROR", "KINTONE_HTTP_500"],
  ])("classifies HTTP %i as %s with a stable code", (status, resultCode, code) => {
    const input = context(true);
    input.cause = { status };
    const result = normalizeJobOutcome(outcome("FAILED", EXIT.RUNTIME), input);
    expect(result.resultCode).toBe(resultCode);
    expect(result.error?.code).toBe(code);
  });
});
