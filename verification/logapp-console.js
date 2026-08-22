/**
 * kSQL Flow 実行ログアプリ生成スクリプト（kintone 画面のブラウザ console 用）
 *
 * 使い方:
 *   1. kintone にログインした状態で、対象スペースのページを開く
 *      （URL 例: https://<dev>.cybozu.com/k/#/space/356/thread/399）
 *   2. ブラウザの開発者ツール (F12) → Console にこのファイル全文を貼り付けて Enter
 *   3. スペース・スレッドは URL から自動取得され、アプリ作成 → フィールド追加 →
 *      デプロイまで自動で行われる。完了時にアプリ ID が表示される
 *   4. 表示されたアプリ ID で API トークン（閲覧 + 追加 + 編集）を発行し、
 *      リポジトリ外 dev.env の KSQL_DEV_TOKEN_LOGS に設定する
 *   5. `./verification/run-dev.ps1 validate --check-logapp --profile dev` で
 *      フィールド定義（job_key の重複禁止含む）を検査する
 *
 * 注意:
 *   - ログイン済みセッションで kintone.api() を使うため、認証情報の入力は不要
 *   - フィールド定義は src/logapp.ts の LOG_APP_FIELDS（設計書 8.2）の写し。
 *     乖離は手順 5 の --check-logapp が検出する
 */
(async () => {
  const APP_NAME = "kSQL Flow 実行ログ";

  // --- スペース / スレッドを URL から取得 -----------------------------------
  const hash = location.href;
  const match = hash.match(/\/space\/(\d+)(?:\/thread\/(\d+))?/);
  if (!match) {
    console.error("スペースのページで実行してください（URL に /space/<id> が含まれること）");
    return;
  }
  const space = Number(match[1]);
  let thread = match[2] !== undefined ? Number(match[2]) : null;
  if (thread === null) {
    const info = await kintone.api(kintone.api.url("/k/v1/space.json", true), "GET", { id: space });
    thread = Number(info.defaultThread);
  }
  console.log(`スペース ${space} / スレッド ${thread} にログアプリを作成します`);

  // --- フィールド定義（src/logapp.ts LOG_APP_FIELDS = 設計書 8.2 の写し） ----
  const DROP = (code, label, options) => ({
    type: "DROP_DOWN", code, label,
    options: Object.fromEntries(options.map((o, i) => [o, { label: o, index: String(i) }])),
  });
  const TEXT = (code, label, unique) => ({
    type: "SINGLE_LINE_TEXT", code, label, ...(unique ? { unique: true } : {}),
  });
  const DATETIME = (code, label) => ({ type: "DATETIME", code, label });
  const NUMBER = (code, label) => ({ type: "NUMBER", code, label });
  const MULTI = (code, label) => ({ type: "MULTI_LINE_TEXT", code, label });

  const properties = {};
  for (const f of [
    DROP("record_type", "レコード種別", ["BATCH", "JOB"]),
    DROP("status", "ステータス", ["SUCCESS", "NO_DATA", "FAILED", "ABORTED", "SKIPPED", "RUNNING", "TIMEOUT"]),
    TEXT("batch_id", "バッチ実行ID"),
    TEXT("parent_batch_id", "親バッチID"),
    TEXT("job_key", "ジョブキー", true), // 重複禁止 = 分散ロックの要
    TEXT("job_key_done", "ジョブキー履歴"),
    TEXT("script_name", "スクリプト名"),
    TEXT("profile", "プロファイル"),
    DATETIME("as_of", "実行基準時刻"),
    DATETIME("started_at", "開始日時"),
    DATETIME("finished_at", "終了日時"),
    NUMBER("duration_sec", "所要時間(秒)"),
    NUMBER("read_count", "取得件数"),
    NUMBER("written_count", "更新件数"),
    TEXT("last_written_key", "最終書込キー"),
    NUMBER("api_calls", "API消費回数"),
    TEXT("executed_by", "実行者"),
    TEXT("host", "実行ホスト"),
    TEXT("git_ref", "Git リビジョン"),
    TEXT("ksql_version", "エンジン版数"),
    MULTI("error_message", "エラー内容"),
    MULTI("log_detail", "実行詳細ログ"),
  ]) {
    properties[f.code] = f;
  }

  // --- 作成 → フィールド追加 → デプロイ -------------------------------------
  const url = (path) => kintone.api.url(path, true);
  const created = await kintone.api(url("/k/v1/preview/app.json"), "POST", {
    name: APP_NAME, space, thread,
  });
  const appId = Number(created.app);
  console.log(`アプリを作成しました: ID ${appId}`);

  await kintone.api(url("/k/v1/preview/app/form/fields.json"), "POST", {
    app: appId, properties,
  });
  console.log(`フィールドを追加しました (${Object.keys(properties).length} 個。job_key は重複禁止)`);

  await kintone.api(url("/k/v1/preview/app/deploy.json"), "POST", { apps: [{ app: appId }] });
  for (let i = 0; i < 30; i++) {
    const st = await kintone.api(url("/k/v1/preview/app/deploy.json"), "GET", { apps: [appId] });
    const status = st.apps[0] && st.apps[0].status;
    if (status === "SUCCESS") {
      console.log("%cデプロイ完了", "font-weight:bold");
      console.log(`次の手順:
  1. アプリ ${appId} の設定 → API トークンで「閲覧 + 追加 + 編集」のトークンを発行
  2. リポジトリ外 %USERPROFILE%\\.ksql-flow-dev\\dev.env に追記:
       KSQL_DEV_TOKEN_LOGS=<発行したトークン>
       KSQL_DEV_LOGAPP_ID=${appId}
  3. ksql-flow validate --check-logapp --profile dev で定義を検査`);
      return;
    }
    if (status === "FAIL" || status === "CANCEL") {
      console.error(`デプロイに失敗しました (${status})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error("デプロイ完了を確認できませんでした（タイムアウト）");
})();
