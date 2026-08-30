/* eslint-disable no-console */
/**
 * 実行ログアプリを template v0.4 相当へ更新する（ブラウザ Console 用）
 *
 * 追加内容:
 *   - 相関フィールド 5 個（correlation_id / attempt_id / execution_id / job_id /
 *     runner_execution_started_at）。すべて非必須・重複禁止なし
 *   - status ドロップダウンへ選択肢 CANCELLED を追加（既存選択肢・既定値は変更しない）
 *   - フォームレイアウト: 追加 5 フィールドを batch_id の行の直後へ 2 行で配置
 *     （1 行目: 相関ID / 試行ID / 実行ID、2 行目: 論理ジョブ名 / SQL実行開始日時）
 *
 * 使い方:
 *   1. kintone にアプリ管理権限のあるアカウントでログインする
 *   2. 対象アプリ（実行ログ）のページを開く  例: /k/<appId>/
 *   3. ブラウザの開発者ツール → Console にこのファイルの内容を丸ごと貼り付けて実行
 *   4. 確認ダイアログで OK を押すとデプロイ（= アプリの設定を反映）まで行う
 *
 * 安全性:
 *   - 既に存在するフィールド・選択肢は飛ばす（何度実行してもよい）
 *   - 既存フィールドの定義（status の既存選択肢・既定値を含む）とレコードは変更しない
 *   - デプロイ前に confirm で止まる。キャンセルすれば preview に残るだけなので、
 *     kintone の画面から「アプリの設定を反映する」または「変更を中止」で処理できる
 *   - rollback: 追加した 5 フィールドと CANCELLED 選択肢をフォーム設定から削除して
 *     反映すれば v0.3 相当へ戻る（既存レコードの値は失われる点のみ注意）
 *
 * 定義の正: ksql-flow src/logapp.ts LOG_APP_FIELDS（template v0.4）
 */
(async () => {
  // ---- 対象アプリ ------------------------------------------------------
  // URL から自動判定する。うまく取れないときはここに直接 ID を書く。
  const APP_ID_OVERRIDE = null; // 例: 4249

  const path = location.pathname;
  const appId =
    APP_ID_OVERRIDE ??
    (path.match(/\/k\/(?:guest\/\d+\/)?(\d+)\//)?.[1] ||
      new URLSearchParams(location.search).get("app") ||
      path.match(/\/k\/admin\/app\/(\d+)\//)?.[1]);

  if (!appId) {
    console.error("アプリ ID を判定できませんでした。APP_ID_OVERRIDE に指定してください。");
    return;
  }

  // ---- 追加するフィールド定義（src/logapp.ts LOG_APP_FIELDS と一致させる） ----
  const FIELDS = {
    correlation_id: {
      type: "SINGLE_LINE_TEXT",
      code: "correlation_id",
      label: "相関ID",
      required: false,
      unique: false,
    },
    attempt_id: {
      type: "SINGLE_LINE_TEXT",
      code: "attempt_id",
      label: "試行ID",
      required: false,
      unique: false,
    },
    execution_id: {
      type: "SINGLE_LINE_TEXT",
      code: "execution_id",
      label: "実行ID",
      required: false,
      unique: false,
    },
    job_id: {
      type: "SINGLE_LINE_TEXT",
      code: "job_id",
      label: "論理ジョブ名",
      required: false,
      unique: false,
    },
    runner_execution_started_at: {
      type: "DATETIME",
      code: "runner_execution_started_at",
      label: "SQL実行開始日時",
      required: false,
      unique: false,
      defaultNowValue: false, // 自動で現在時刻を入れない（ランナーが SQL 開始直前に書く耐久証跡）
    },
  };
  const STATUS_NEW_OPTION = "CANCELLED";

  // レイアウト: batch_id の行の直後へこの順で 2 行挿入する
  const LAYOUT_ROWS = [
    ["correlation_id", "attempt_id", "execution_id"],
    ["job_id", "runner_execution_started_at"],
  ];
  const FIELD_WIDTH = "193"; // 既存 1 行テキスト系と揃える標準幅

  // ---- API ヘルパ ------------------------------------------------------
  // 素の fetch は POST で CSRF トークン切れ (CB_CS01) になるため、
  // kintone ページで使える kintone.api()（要求トークンを自動付与）で呼ぶ。
  if (typeof kintone === "undefined" || typeof kintone.api !== "function") {
    console.error("kintone.api が見つかりません。kintone のアプリ画面（一覧やレコード詳細）で実行してください。");
    return;
  }
  const api = async (endpoint, method, body) => {
    try {
      // kintone.api.url(..., true) は .json 付与とゲストスペースを自動処理する
      return await kintone.api(kintone.api.url(`/k/v1${endpoint}`, true), method, body ?? {});
    } catch (e) {
      throw new Error(`${method} ${endpoint} -> ${JSON.stringify(e)}`);
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    console.log(`%c対象アプリ: ${appId}`, "font-weight:bold");

    // 1. preview のフォーム定義を取得（= アプリ管理権限の確認も兼ねる）
    const preview = await api("/preview/app/form/fields", "GET", { app: appId });
    const existing = new Set(Object.keys(preview.properties));

    const toAdd = {};
    const skipped = [];
    for (const [code, def] of Object.entries(FIELDS)) {
      if (existing.has(code)) skipped.push(code);
      else toAdd[code] = def;
    }
    if (skipped.length) console.log("既に存在（スキップ）:", skipped.join(", "));

    // 2. status への CANCELLED 追加要否を判定（既存定義を丸ごと引き継いで options だけ増やす）
    const status = preview.properties.status;
    let statusUpdate = null;
    if (!status || status.type !== "DROP_DOWN") {
      console.warn("status フィールド（DROP_DOWN）が見つかりません。ksql-flow のログアプリか確認してください。");
    } else if (Object.keys(status.options).includes(STATUS_NEW_OPTION)) {
      console.log(`status に ${STATUS_NEW_OPTION} は既に存在（スキップ）`);
    } else {
      const nextIndex = String(
        Math.max(...Object.values(status.options).map((o) => Number(o.index))) + 1
      );
      statusUpdate = {
        type: "DROP_DOWN",
        code: "status",
        label: status.label,
        required: status.required,
        defaultValue: status.defaultValue, // 既定値は変更しない
        options: {
          ...status.options,
          [STATUS_NEW_OPTION]: { label: STATUS_NEW_OPTION, index: nextIndex },
        },
      };
    }

    if (Object.keys(toAdd).length === 0 && statusUpdate === null) {
      console.log("%c変更すべき点はありません（v0.4 適用済み）。", "color:green;font-weight:bold");
      return;
    }

    if (Object.keys(toAdd).length) {
      console.log("追加するフィールド:");
      console.table(
        Object.values(toAdd).map((f) => ({ コード: f.code, ラベル: f.label, 型: f.type }))
      );
    }
    if (statusUpdate) console.log(`status へ選択肢 ${STATUS_NEW_OPTION} を追加します（既存選択肢・既定値は不変）`);

    if (
      !confirm(
        `実行ログアプリ (${appId}) へ v0.4 更新を適用してデプロイします。\n` +
          `- フィールド追加: ${Object.keys(toAdd).length} 個\n` +
          `- status への ${STATUS_NEW_OPTION} 追加: ${statusUpdate ? "あり" : "なし"}\n` +
          `- レイアウト: batch_id 行の直後へ配置\nよろしいですか？`
      )
    ) {
      console.log("中止しました（preview にも書いていません）。");
      return;
    }

    // 3. preview へフィールド追加・status 更新
    if (Object.keys(toAdd).length) {
      const added = await api("/preview/app/form/fields", "POST", { app: appId, properties: toAdd });
      console.log(`フィールドを preview へ追加しました (revision ${added.revision})`);
    }
    if (statusUpdate) {
      const updated = await api("/preview/app/form/fields", "PUT", {
        app: appId,
        properties: { status: statusUpdate },
      });
      console.log(`status へ ${STATUS_NEW_OPTION} を追加しました (revision ${updated.revision})`);
    }

    // 4. レイアウト設定: API 追加分は末尾へ自動配置されるため、いったん取り除いて
    //    batch_id の行の直後へ 2 行で挿入し直す（既存行の構成は変更しない）
    const targetCodes = new Set(Object.keys(FIELDS));
    const layout = await api("/preview/app/form/layout", "GET", { app: appId });
    const cleanedLayout = layout.layout
      .map((row) =>
        row.type === "ROW"
          ? { ...row, fields: row.fields.filter((f) => !targetCodes.has(f.code)) }
          : row
      )
      .filter((row) => row.type !== "ROW" || row.fields.length > 0);

    const placedCodes = new Set(
      cleanedLayout.flatMap((row) => (row.type === "ROW" ? row.fields.map((f) => f.code) : []))
    );
    const newRows = LAYOUT_ROWS.map((codes) => ({
      type: "ROW",
      fields: codes
        .filter((code) => !placedCodes.has(code))
        .map((code) => ({
          type: FIELDS[code].type,
          code,
          size: { width: FIELD_WIDTH },
        })),
    })).filter((row) => row.fields.length > 0);

    if (newRows.length) {
      let insertAt = cleanedLayout.findIndex(
        (row) => row.type === "ROW" && row.fields.some((f) => f.code === "batch_id")
      );
      insertAt = insertAt === -1 ? cleanedLayout.length : insertAt + 1;
      cleanedLayout.splice(insertAt, 0, ...newRows);
      await api("/preview/app/form/layout", "PUT", { app: appId, layout: cleanedLayout });
      console.log(
        insertAt === cleanedLayout.length - newRows.length && insertAt !== 0
          ? "レイアウト: batch_id 行が見つからないため末尾へ配置しました"
          : "レイアウト: batch_id 行の直後へ 2 行で配置しました"
      );
    }

    // 5. デプロイ
    await api("/preview/app/deploy", "POST", { apps: [{ app: appId }] });
    console.log("デプロイを要求しました。反映を待ちます…");
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const st = await api("/preview/app/deploy", "GET", { apps: [appId] });
      const s = st.apps?.[0]?.status;
      console.log(`  ${s}`);
      if (s === "SUCCESS") break;
      if (s === "FAIL" || s === "CANCEL") throw new Error(`デプロイが ${s} で終了しました`);
    }

    // 6. 本番フォームで検証
    const live = await api("/app/form/fields", "GET", { app: appId });
    console.log("%c検証結果:", "font-weight:bold");
    let ng = 0;
    for (const [code, def] of Object.entries(FIELDS)) {
      const f = live.properties[code];
      const problems = [];
      if (!f) problems.push("見つかりません");
      else {
        if (f.type !== def.type) problems.push(`型が ${f.type}（期待 ${def.type}）`);
        if (f.required) problems.push("必須になっている");
        if (f.unique) problems.push("重複禁止になっている");
      }
      if (problems.length) {
        console.error(`  NG ${code}: ${problems.join(" / ")}`);
        ng += 1;
      } else {
        console.log(`  OK ${code} (${f.type}) ${f.label}`);
      }
    }
    const liveStatus = live.properties.status;
    if (liveStatus && Object.keys(liveStatus.options).includes(STATUS_NEW_OPTION)) {
      console.log(`  OK status に ${STATUS_NEW_OPTION} あり`);
    } else {
      console.error(`  NG status に ${STATUS_NEW_OPTION} がありません`);
      ng += 1;
    }
    console.log(
      ng === 0 ? "%c完了: v0.4 更新はすべて正常です。" : `%c${ng} 件に問題があります。`,
      ng === 0 ? "color:green;font-weight:bold" : "color:red;font-weight:bold"
    );
    if (ng === 0) {
      console.log(
        "確認（任意・kintone の画面から）: " +
          "①フォームで相関 5 フィールドが batch_id の直後に並んでいること " +
          "②`ksql-flow validate --check-logapp` が新フィールドを認識すること " +
          "③orchestrator 経由の実行で correlation_id 等が記録されること"
      );
    }
  } catch (e) {
    console.error("失敗:", e.message);
    if (String(e.message).includes("403") || String(e.message).includes("CB_NO02")) {
      console.error("アプリ管理権限のあるアカウントでログインしているか確認してください。");
    }
  }
})();
