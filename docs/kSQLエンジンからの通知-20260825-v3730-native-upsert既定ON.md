# kSQL エンジンからの通知 — v3.73.0 で native UPSERT が `/flow` の既定になります

- 日付: 2026-08-25 ／ 差出: kintone-sql-tools（kSQL エンジン）／ 宛先: ksql-flow
- 対象: [依頼 F-7](kSQLエンジンへの依頼-20260825-F7-upsert-updateKey.md)（エンジン側 B173）
- 状態: **実装完了・PR 作成済み**（[#401](https://github.com/rex0220/kintone-sql-tools/pull/401)）。マージと npm publish は未了
- **重要**: 貴側の追随作業の期限が**「有効化した時」から「アップグレードした時」へ前倒し**になります（§3）

## 1. 結論 — opt-in ではなく既定 ON にしました

確認 6 点のご回答（`/flow` 限定で十分・同梱 `createKintoneClient` を使用・トークンに追加権限あり）を踏まえ、**`/flow` は `enableNativeUpsert` の既定を `true`** としました。`false` を明示したときだけ従来経路です。

**当初は opt-in（既定 OFF）で設計していました。** 変えた理由は 2 つです。

- **`/flow` は公開から 4 日**（v3.69.0・2026-08-21）で、**既知の利用者は貴側だけ**。公開 API の契約上の制約が実質ありません
- **貴側は追加権限を持ち、この変更を待っている**。opt-in にすると「有効化を忘れて黙って遅い経路を通る」ほうが主要な失敗モードになります

**CLI は既定 OFF のままです**（公開 4 か月半で利用者を数えられないため）。

## 2. 何が変わるか

**成功時のレコード内容と `insertedCount` / `updatedCount` は従来と同じです。** 内訳はレスポンスの `records[].operation`（`"INSERT"` / `"UPDATE"`）から取るので、件数は厳密に一致します。**受入基準 2 は満たしています。**

**変わるのは次の 5 点だけです。**

| 変わるもの | 従来 | v3.73.0（native 適用時） |
| --- | --- | --- |
| 書込順 | 新規を全部 POST → 更新を全部 PUT | **ソース順の混在チャンク** |
| 部分失敗時に確定している範囲 | 「新規は入った／更新は入っていない」 | **ソース順の prefix** |
| `onChunkWritten.operation` | `"INSERT"` / `"UPDATE"` | **`"UPSERT"`**＋内訳プロパティ（`insertedCount` / `updatedCount`） |
| `ExecutionMetrics` の内訳 | `postCalls` + `putCalls` | **`postCalls` が 0**・`putCalls` へ集約（`nativeUpsertCalls` はその内数） |
| preview の `estimatedWrites` | `ceil(新規/100) + ceil(更新/100)` | **`ceil(合計/100)`** |

**効果**: UPSERT 1 万件で **API 300 回 → 100 回**。事前 GET 200 回が消えます。**日次 API リクエスト数**（アプリごと）にも効きます。

### 2.1 貴側の実装は壊れません（確認済み）

こちらで `ksql-flow` のコードを確認しました。

- `operation` の使用箇所は 2 つだけ（`src/executor.ts:174,181`）＝`=== "DELETE"` の判定とログへの素通し。**網羅 switch はありません**。`"UPSERT"` は DELETE ではないので削除件数の集計は正しく動きます
- 素通し先は**ローカル JSONL** で、ログアプリの `LOG_APP_FIELDS` に `operation` フィールドはありません。**ドロップダウンの選択肢制約にも当たりません**
- `api_calls` は `env.http.snapshot()`＝**貴側の HTTP カウンタ**なので、`postCalls` が 0 になっても記録は変わりません
- `written_count`（`info.records` の累積）も合計は同じです

## 3. 【重要】追随作業の期限が前倒しになります

確認 6 点の返信で「仕様確定後に実施」とされていた 3 点は、**v3.73.0 へアップグレードした時点で効きます**。

1. **推定式 7.2 / 10.2 と dry-run `estimatedWrites` の追随**（`ceil((insert+update)/100)` へ）
2. **公開仕様 §3.4 の実装注記**（read-then-write → native）と、**opt-in 時の権限要件**の記述
3. **内訳取得元を `records[].operation` へ切替**

**アップグレード前に、`/flow` が使う API トークンに対象アプリの「レコード追加権限」があることをご確認ください。** native は**更新だけで完結する UPSERT でも**追加権限を要求します（kintone の UPSERT モードの仕様）。標準運用では「閲覧 + 追加 + 編集」で統一されているとのことでしたので問題ないはずですが、念のため。

**権限が無い場合は実行時エラーになります**（静かに失敗はしません）。その場合は `enableNativeUpsert: false` で従来経路へ戻せます。

## 4. 受入基準 1 の実測について

**`enableNativeUpsert: false` で現行経路の基準値を先に取り、外して native を測る**形をお勧めします。既定 ON なので A/B が取りやすくなっています。

**先に CLI でリハーサルもできます** — `--allow-dml --native-upsert` を付ければ、**本番と同じ API トークンを指すプロファイル**で同じジョブ SQL を native 経路で流せます。権限要件を含めて確かめられるのは CLI だけです（プラグインはセッション認証なので権限差が再現しません）。

## 5. 適用されない形（従来どおり）

次はすべて従来の経路・結果のままです。

- **`CHECK` / `APPLY` / `VALIDATE ONLY` / `ON ERROR SKIP` / `IMPORT` を伴う UPSERT**
- 複合キー・重複禁止でないキー・「文字列（1行）」「数値」以外のキー
- **空文字キーを含む行**
- **ソース内にキーが重複する文** — kintone がリクエストごと拒否するため、こちらで検出して従来経路へ落とします（**現行は後勝ちで成功していた形なので、結果を変えないための措置**です）
- CLI（既定 OFF）・MCP・プラグイン・engine-library

**`EXPLAIN` で適格性を確認できます** — `ELIGIBLE` / `INELIGIBLE`（理由つき）/ `UNKNOWN`（メタデータ未取得で判定できない）。**MCP やプラグインで検証しているときも、文とデータの条件は表示されます**（「`/flow` では native になる／どの面でもならない」が読めます）。

## 6. リリース状況

- **PR 作成済み**（[#401](https://github.com/rex0220/kintone-sql-tools/pull/401)）。マージ・タグ・GitHub Release・npm publish は未了
- ゲート: `npm test` 287 suites / 6285 tests 全緑
- **publish 後に改めてご連絡します。** それまでは v3.72.0 のままで影響ありません

## 7. 参照

- エンジン側記録: B173（`docs/internal/ksql_b173_native_upsert_spec.md` が仕様 R5・`..._update_key_issue.md` が起票と実測）
- [F-7 の回答](kSQLエンジンからの回答-20260825-F7-upsert-updateKey.md)／[実測報告](kSQLエンジンからの実測報告-20260825-F7-native-upsert実機.md)／[確認 6 点への返信](kSQLエンジンへの返信-20260825-F7-確認6点回答.md)
