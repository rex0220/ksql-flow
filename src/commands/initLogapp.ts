import { ResolvedProfile } from "../config";
import { ConfigError, errorMessage } from "../errors";
import { expectedLogFieldCodes, LOG_APP_FIELDS } from "../logapp";
import { createRunnerEnv } from "../runner";
import { EXIT, ExitCode } from "../types";

/**
 * init-logapp（設計書 付録 B / タスク指示書 L）。
 * kintone アプリ作成 API（preview 系）で 8.2 定義のログアプリを作成し、
 * job_key の重複禁止設定まで行う。アプリ作成 API はユーザー認証必須のため
 * auth.type: password のプロファイルでのみ実行できる（調査報告 §4 補足）。
 */
export async function initLogAppCommand(
  profile: ResolvedProfile,
  options: { name?: string; baseFetch?: typeof fetch; out?: (line: string) => void } = {}
): Promise<ExitCode> {
  const env = createRunnerEnv(profile, { baseFetch: options.baseFetch, out: options.out });
  const out = env.out;
  if (profile.auth.type !== "password") {
    out("エラー: init-logapp は kintone アプリ作成 API を使うため auth.type: password のプロファイルが必要です");
    out("（API トークンではアプリを作成できません。作成後の運用は apiToken に戻せます）");
    return EXIT.VALIDATION;
  }
  const appName = options.name ?? "kSQL Flow 実行ログ";

  const api = makePreviewApi(profile, env.http.fetch);
  try {
    out(`ログアプリを作成します: "${appName}" (${profile.baseUrl})`);
    const { app } = await api.post<{ app: string }>("/k/v1/preview/app.json", { name: appName });
    const appId = Number(app);
    out(`  アプリ ID: ${appId}`);

    await api.post("/k/v1/preview/app/form/fields.json", {
      app: appId,
      properties: buildFieldProperties(),
    });
    out(`  フィールドを追加しました (${expectedLogFieldCodes().length} 個。job_key は重複禁止)`);

    await api.post("/k/v1/preview/app/deploy.json", { apps: [{ app: appId }] });
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await api.get<{ apps: Array<{ app: string; status: string }> }>(
        `/k/v1/preview/app/deploy.json?apps[0]=${appId}`
      );
      const deployStatus = status.apps[0]?.status;
      if (deployStatus === "SUCCESS") {
        out("  デプロイが完了しました");
        out("");
        out("次の設定を ksql.config.json に追加してください:");
        out(`  "apps": { "実行ログ": { "id": ${appId}, "tokens": ["env:KSQL_TOKEN_LOGS"] } },`);
        out(`  "logApp": "実行ログ"`);
        return EXIT.OK;
      }
      if (deployStatus === "FAIL" || deployStatus === "CANCEL") {
        out(`エラー: デプロイに失敗しました (${deployStatus})`);
        return EXIT.RUNTIME;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    out("エラー: デプロイ完了を確認できませんでした（タイムアウト）");
    return EXIT.RUNTIME;
  } catch (error) {
    out(`エラー: ログアプリの作成に失敗しました: ${env.masker.mask(errorMessage(error))}`);
    return EXIT.RUNTIME;
  }
}

/** --check-logapp（設計書 付録 B）: 既存ログアプリのフィールド過不足検査 */
export async function checkLogAppCommand(
  profile: ResolvedProfile,
  options: { baseFetch?: typeof fetch; out?: (line: string) => void } = {}
): Promise<ExitCode> {
  const env = createRunnerEnv(profile, { baseFetch: options.baseFetch, out: options.out });
  const out = env.out;
  if (profile.logApp === undefined) {
    out("エラー: logApp が設定されていません");
    return EXIT.VALIDATION;
  }
  const appId = profile.apps[profile.logApp].id;
  let fields;
  try {
    fields = await env.client.getFields(appId);
  } catch (error) {
    out(`エラー: ログアプリのフィールド取得に失敗しました: ${errorMessage(error)}`);
    return EXIT.RUNTIME;
  }
  const byCode = new Map(fields.map((field) => [field.code, field]));
  let problems = 0;
  for (const [code, def] of Object.entries(LOG_APP_FIELDS)) {
    const actual = byCode.get(code);
    if (actual === undefined) {
      out(`  NG: フィールド "${code}" (${def.label}) がありません (期待タイプ: ${def.type})`);
      problems += 1;
      continue;
    }
    if (actual.fieldType !== def.type) {
      out(`  NG: フィールド "${code}" のタイプが ${actual.fieldType} です (期待: ${def.type})`);
      problems += 1;
    }
    if (def.unique === true && actual.isUnique !== true) {
      out(`  NG: フィールド "${code}" に「値の重複を禁止する」が設定されていません（分散ロックの前提）`);
      problems += 1;
    }
  }
  if (problems === 0) {
    out(`OK: ログアプリ (ID ${appId}) は 8.2 のフィールド定義を満たしています`);
    return EXIT.OK;
  }
  out(`NG: ${problems} 件の不備があります`);
  return EXIT.VALIDATION;
}

function buildFieldProperties(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [code, def] of Object.entries(LOG_APP_FIELDS)) {
    if (def.type === "DROP_DOWN") {
      const options: Record<string, { label: string; index: string }> = {};
      def.options?.forEach((option, index) => {
        options[option] = { label: option, index: String(index) };
      });
      properties[code] = { type: "DROP_DOWN", code, label: def.label, options };
    } else if (def.type === "DATETIME") {
      properties[code] = { type: "DATETIME", code, label: def.label };
    } else if (def.type === "NUMBER") {
      properties[code] = { type: "NUMBER", code, label: def.label };
    } else if (def.type === "MULTI_LINE_TEXT") {
      properties[code] = { type: "MULTI_LINE_TEXT", code, label: def.label };
    } else {
      properties[code] = {
        type: "SINGLE_LINE_TEXT",
        code,
        label: def.label,
        ...(def.unique === true ? { unique: true } : {}),
      };
    }
  }
  return properties;
}

/** preview 系 API（アプリ作成）はエンジン client に無いため、共通 HTTP 層の上で直接呼ぶ */
function makePreviewApi(profile: ResolvedProfile, fetchImpl: typeof fetch) {
  if (profile.auth.type !== "password" || profile.auth.username === undefined || profile.auth.password === undefined) {
    throw new ConfigError("init-logapp には password 認証が必要です");
  }
  const authHeader = Buffer.from(`${profile.auth.username}:${profile.auth.password}`).toString("base64");
  const base = profile.baseUrl.replace(/\/+$/, "");
  const guestPrefix = profile.guestSpaceId !== undefined ? `/k/guest/${profile.guestSpaceId}` : "";
  const request = async <T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> => {
    const url = `${base}${path.replace(/^\/k/, guestPrefix === "" ? "/k" : guestPrefix)}`;
    const response = await fetchImpl(url, {
      method,
      headers: {
        "X-Cybozu-Authorization": authHeader,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message !== undefined) message = `${message}: ${parsed.message}`;
      } catch {
        /* noop */
      }
      throw new Error(`kintone アプリ作成 API エラー (${path}): ${message}`);
    }
    return text === "" ? ({} as T) : (JSON.parse(text) as T);
  };
  return {
    get: <T>(path: string) => request<T>(path, "GET"),
    post: <T>(path: string, body: unknown) => request<T>(path, "POST", body),
  };
}
