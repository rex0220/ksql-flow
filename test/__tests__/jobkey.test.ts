import { buildBatchJobKey, buildJobKey, MAX_JOB_KEY_LENGTH } from "../../src/jobkey";
import { ConfigError } from "../../src/errors";

describe("job_key 入力ガード", () => {
  test("正常キーと内部バッチキーは従来形式を維持する", () => {
    expect(buildJobKey("prod", "daily_sales")).toBe("prod:daily_sales");
    expect(buildBatchJobKey("prod")).toBe("prod:__batch__");
  });

  test("ジョブ名 __batch__ は予約語として拒否する", () => {
    expect(() => buildJobKey("prod", "__batch__")).toThrow(ConfigError);
    expect(() => buildJobKey("prod", "__batch__")).toThrow(/予約語.*@ksql name/);
  });

  test.each([
    ["プロファイル", "prod:west", "daily", /プロファイル名.*:.*ksql\.config\.json/],
    ["ジョブ", "prod", "daily:sales", /ジョブ名.*:.*@ksql name/],
  ])("%s 名の ':' を拒否する", (_label, profile, job, message) => {
    expect(() => buildJobKey(profile, job)).toThrow(message);
  });

  test("完成キーは 64 UTF-16 コード単位を受理し、65 を拒否する", () => {
    const atLimit = buildJobKey("p", "a".repeat(MAX_JOB_KEY_LENGTH - 2));
    expect(atLimit.length).toBe(64);
    expect(() => buildJobKey("p", "a".repeat(MAX_JOB_KEY_LENGTH - 1))).toThrow(/65 文字.*上限 64/);
  });

  test("サロゲートペアを 2 UTF-16 コード単位として境界判定する", () => {
    const acceptedName = `${"😀".repeat(30)}ab`; // 32 コードポイント / 62 UTF-16 単位
    const rejectedName = `${"😀".repeat(31)}a`; // 32 コードポイント / 63 UTF-16 単位
    expect(acceptedName.length).toBe(62);
    expect(buildJobKey("p", acceptedName).length).toBe(64);
    expect(rejectedName.length).toBe(63);
    expect(() => buildJobKey("p", rejectedName)).toThrow(/65 文字.*UTF-16/);
  });

  test("内部バッチキーの超過は profile 名の短縮を案内する", () => {
    expect(() => buildBatchJobKey("p".repeat(56))).toThrow(/上限 64.*ksql\.config\.json のプロファイル名/);
  });
});
