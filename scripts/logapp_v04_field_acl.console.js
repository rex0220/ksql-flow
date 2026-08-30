/* eslint-disable no-console */
/**
 * 実行ログアプリの v0.4 追加フィールドを Everyone = 閲覧のみ にする（ブラウザ Console 用）
 *
 * 対象: correlation_id / attempt_id / execution_id / job_id / runner_execution_started_at
 *
 * 理由:
 *   - これらは orchestrator（kSQL-FlowNet）実行の監査相関と、SQL 開始の耐久証跡
 *     （runner_execution_started_at は結果 JSON 欠損時の復旧判断材料）。
 *     人間が UI から編集できると監査・復旧判断の根拠が崩れる。
 *   - API トークン（ランナー）は Administrator 相当でフィールドアクセス権の対象外の
 *     ため、この設定はランナーの書込を一切妨げない（rerun フィールド ACL と同じ方式）。
 *
 * 使い方:
 *   1. アプリ管理権限のあるアカウントで、実行ログアプリの一覧画面を開く
 *   2. Console にこのファイルを丸ごと貼り付けて実行
 *   3. 確認ダイアログで OK → デプロイまで自動
 *
 * 安全性:
 *   - フィールドアクセス権の PUT は「全置換」のため、現在の設定を取得して不足分だけを
 *     追加する。既にアクセス権が設定されているフィールドには触れない（何度実行してもよい）
 *   - 先に scripts/logapp_v04_upgrade.console.js でフィールドを追加しておくこと
 *   - status / job_key 等の既存フィールドも閲覧のみにしたい場合は、my-ksql-jobs の
 *     dev/set_rerun_field_acl.console.js（全編集可能フィールドを対象にする方式）を参照
 */
(async () => {
  const APP_ID_OVERRIDE = null; // 自動判定できないときはアプリ ID を記入

  const appId =
    APP_ID_OVERRIDE ??
    (location.pathname.match(/\/k\/(?:guest\/\d+\/)?(\d+)\//)?.[1] ||
      new URLSearchParams(location.search).get("app") ||
      location.pathname.match(/\/k\/admin\/app\/(\d+)\//)?.[1]);
  if (!appId) {
    console.error("アプリ ID を判定できませんでした。APP_ID_OVERRIDE に指定してください。");
    return;
  }
  if (typeof kintone === "undefined" || typeof kintone.api !== "function") {
    console.error("kintone.api が見つかりません。kintone のアプリ画面（一覧など）で実行してください。");
    return;
  }

  const TARGET_FIELDS = [
    "correlation_id",
    "attempt_id",
    "execution_id",
    "job_id",
    "runner_execution_started_at",
  ];

  const api = async (endpoint, method, body) => {
    try {
      return await kintone.api(kintone.api.url(`/k/v1${endpoint}`, true), method, body ?? {});
    } catch (e) {
      throw new Error(`${method} ${endpoint} -> ${JSON.stringify(e)}`);
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    console.log(`%c対象アプリ: ${appId}`, "font-weight:bold");

    // 1. v0.4 フィールドの存在確認（未適用アプリへの誤設定を防ぐ）
    const form = await api("/preview/app/form/fields", "GET", { app: appId });
    const missing = TARGET_FIELDS.filter((code) => !(code in form.properties));
    if (missing.length) {
      console.error(
        `v0.4 フィールドが不足しています: ${missing.join(", ")}\n` +
          "先に scripts/logapp_v04_upgrade.console.js を実行してください。"
      );
      return;
    }

    // 2. 現在の（preview の）フィールドアクセス権を取得 — PUT が全置換のため必須
    const current = await api("/preview/field/acl", "GET", { app: appId });
    const rights = current.rights ?? [];
    const configured = new Set(rights.map((r) => r.code));

    const toAdd = TARGET_FIELDS.filter((code) => !configured.has(code));
    const skipped = TARGET_FIELDS.filter((code) => configured.has(code));
    if (skipped.length) console.log("既にアクセス権設定あり（変更しない）:", skipped.join(", "));
    if (toAdd.length === 0) {
      console.log("%c追加すべき設定はありません（適用済み）。", "color:green;font-weight:bold");
      return;
    }
    console.log("Everyone = 閲覧のみ を追加するフィールド:", toAdd.join(", "));

    if (
      !confirm(
        `実行ログアプリ (${appId}) の相関フィールド ${toAdd.length} 件を Everyone=閲覧のみ にしてデプロイします。\n` +
          "既存のアクセス権設定は変更しません。ランナー（API トークン）の書込は影響を受けません。よろしいですか？"
      )
    ) {
      console.log("中止しました。");
      return;
    }

    // 3. 全置換 PUT（既存 + 追加）
    await api("/preview/field/acl", "PUT", {
      app: appId,
      rights: [
        ...rights,
        ...toAdd.map((code) => ({
          code,
          entities: [{ entity: { type: "GROUP", code: "everyone" }, accessibility: "READ" }],
        })),
      ],
    });
    console.log("preview へ反映しました。デプロイします…");

    await api("/preview/app/deploy", "POST", { apps: [{ app: appId }] });
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const st = await api("/preview/app/deploy", "GET", { apps: [appId] });
      const status = st.apps?.[0]?.status;
      console.log(`  ${status}`);
      if (status === "SUCCESS") break;
      if (status === "FAIL" || status === "CANCEL") throw new Error(`デプロイが ${status} で終了しました`);
    }

    // 4. 検証
    const live = await api("/field/acl", "GET", { app: appId });
    const byCode = new Map((live.rights ?? []).map((r) => [r.code, r]));
    let ng = 0;
    console.log("%c検証結果:", "font-weight:bold");
    for (const code of TARGET_FIELDS) {
      const r = byCode.get(code);
      const summary = r?.entities?.map((e) => `${e.entity.code}:${e.accessibility}`).join(", ");
      if (r && r.entities.some((e) => e.entity.code === "everyone" && e.accessibility === "READ")) {
        console.log(`  OK ${code} [${summary}]`);
      } else {
        console.error(`  NG ${code} [${summary ?? "設定なし"}]`);
        ng += 1;
      }
    }
    console.log(
      ng === 0
        ? "%c完了: 相関 5 フィールドはすべて Everyone=閲覧のみ です（ランナーの書込は可能なまま）。"
        : `%c${ng} 件に問題があります。`,
      ng === 0 ? "color:green;font-weight:bold" : "color:red;font-weight:bold"
    );
  } catch (e) {
    console.error("失敗:", e.message);
    if (String(e.message).includes("403")) {
      console.error("アプリ管理権限のあるアカウントでログインしているか確認してください。");
    }
  }
})();
