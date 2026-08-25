# F-7 追随チェックリスト — エンジン v3.73.0（native UPSERT 既定 ON）へのアップグレード時作業

- 起票: 2026-08-25（[エンジン通知](../kSQLエンジンからの通知-20260825-v3730-native-upsert既定ON.md) §3 を受けて）
- 発動条件: **エンジン v3.73.0 の npm publish 連絡を受けたとき**（それまでは v3.72.0 のままで影響なし）
- 注意: ksql-flow の依存は `^3.71.0` のため、**エンジン publish の瞬間から新規 `npm install` には自動で v3.73.0 が入り、native が既定で効く**（挙動互換はエンジン側確認済み・`estimatedWrites` の表示だけ旧式のズレ）。追随リリースは publish 連絡後すみやかに出す
- 重要: 通知 §1 のとおり `/flow` は **既定 ON**。「有効化した時」ではなく**「依存を上げた時」に即座に効く**ため、以下を 1 リリースにまとめて行う

## 事前確認（アップグレード前）

- [x] `/flow` が使う API トークンに対象アプリの**レコード追加権限**があること（標準運用「閲覧 + 追加 + 編集」で確認済み — M 実測も権限エラーなし）
- [x] CLI リハーサル → 縮小実測（M・実機）で代替済み

## コード・仕様の追随（ksql-flow リリース 1 本にまとめる）

- [x] `package.json` の依存を `^3.74.0` へ、README 互換表に行追加（v0.4.0）
- [x] **推定式 7.2 / 10.2 と dry-run `estimatedWrites`** を `ceil((insert+update)/100)` へ（従来: `ceil(新規/100) + ceil(更新/100)`）
- [x] **公開仕様 §3.4 の実装注記**を更新: read-then-write → native（updateKey + upsert: true・既定 ON・適用されない形の列挙 = CHECK/APPLY/IMPORT・複合キー・非 unique・空文字キー・ソース内重複は従来経路へ自動 fallback）。**権限要件（追加権限必須）**も明記
- [x] `onChunkWritten.operation` の新値 **`"UPSERT"`** — 型はエンジン 3.74.0 の union で追随済み（typecheck green）。executor は無変更で正（`=== "DELETE"` 判定・JSONL 素通し）。JSONL への内訳（insertedCount/updatedCount）追加は必要が生じるまで見送り
- [x] `ExecutionMetrics` の変化 — 依存箇所なし（`api_calls` は自前 HTTP カウンタ）。全 160 テスト green で確認
- [x] 仕様 §4.1 は影響なし（UPSERT の失敗系挙動は不変）を確認のみ

## 受入実測（受入基準 1 — 通知 §4 の推奨手順）

- [x] **縮小版（M）で実施済み（2026-08-25）**: M 集計ジョブが **API 17 → 14 回**（事前 GET -4 + 適格性判定のフォーム定義 +1 = 差引 -3 で完全一致）。SUCCESS・verify 全一致・cleanup 済み。`enableNativeUpsert: false` の直接 A/B はランナーに off スイッチが無いため旧実測（17 回）を基準値に採用
- [ ] （任意・正式受入）XL 相当の再実測 → **ジョブ全体 511 → 約 312 回**の確認（seed 約 38 分 + 日次 API 上限の相当量を消費するため実施タイミングは要判断）
- [x] 結果を `verification/scale-notes.md` に追記（M 分）。エンジンへの共有は XL 実施判断とあわせて

## ドキュメント・記事系

- [ ] 記事 #3 の「UPSERT の重複判定に使う事前 GET」記述に、v3.73.0 以降は native 化で消えた旨の追記を検討（公開済み記事の更新は任意・時期判断）
- [ ] 定石への 1 行: UPSERT ソースはキーが一意になる形（GROUP BY 集計）に寄せると native 適用が確実（非集約 SELECT + 重複は従来経路 fallback で遅いまま）
- [ ] `EXPLAIN` の適格性表示（ELIGIBLE / INELIGIBLE / UNKNOWN）をテンプレート CLAUDE.md の検証手順に足すか判断
