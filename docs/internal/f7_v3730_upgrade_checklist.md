# F-7 追随チェックリスト — エンジン v3.73.0（native UPSERT 既定 ON）へのアップグレード時作業

- 起票: 2026-08-25（[エンジン通知](../kSQLエンジンからの通知-20260825-v3730-native-upsert既定ON.md) §3 を受けて）
- 発動条件: **エンジン v3.73.0 の npm publish 連絡を受けたとき**（それまでは v3.72.0 のままで影響なし）
- 注意: ksql-flow の依存は `^3.71.0` のため、**エンジン publish の瞬間から新規 `npm install` には自動で v3.73.0 が入り、native が既定で効く**（挙動互換はエンジン側確認済み・`estimatedWrites` の表示だけ旧式のズレ）。追随リリースは publish 連絡後すみやかに出す
- 重要: 通知 §1 のとおり `/flow` は **既定 ON**。「有効化した時」ではなく**「依存を上げた時」に即座に効く**ため、以下を 1 リリースにまとめて行う

## 事前確認（アップグレード前）

- [ ] `/flow` が使う API トークンに対象アプリの**レコード追加権限**があること（native は更新だけで完結する UPSERT でも追加権限を要求。標準運用「閲覧 + 追加 + 編集」なら OK。無い場合は実行時エラー — `enableNativeUpsert: false` で退避可）
- [ ] CLI リハーサル（任意）: `--allow-dml --native-upsert` で本番と同じトークンのプロファイルに対して権限要件込みの事前確認ができる

## コード・仕様の追随（ksql-flow リリース 1 本にまとめる）

- [ ] `package.json` の依存を `^3.73.0` へ、README 互換表に行追加
- [ ] **推定式 7.2 / 10.2 と dry-run `estimatedWrites`** を `ceil((insert+update)/100)` へ（従来: `ceil(新規/100) + ceil(更新/100)`）
- [ ] **公開仕様 §3.4 の実装注記**を更新: read-then-write → native（updateKey + upsert: true・既定 ON・適用されない形の列挙 = CHECK/APPLY/IMPORT・複合キー・非 unique・空文字キー・ソース内重複は従来経路へ自動 fallback）。**権限要件（追加権限必須）**も明記
- [ ] `onChunkWritten.operation` の新値 **`"UPSERT"`**（+ `insertedCount` / `updatedCount`）への型追随。executor の `=== "DELETE"` 判定・JSONL 素通しは無変更で正しく動く（エンジン側確認済み・通知 §2.1）が、型 union の更新と、JSONL に内訳を載せるかを判断
- [ ] `ExecutionMetrics` の変化（`postCalls` = 0・`nativeUpsertCalls` 内数）に依存した表示・テストがないか確認（`api_calls` は自前 HTTP カウンタなので影響なし — エンジン確認済み）
- [ ] 仕様 §4.1 は影響なし（UPSERT の失敗系挙動は不変）を確認のみ

## 受入実測（受入基準 1 — 通知 §4 の推奨手順）

- [ ] `enableNativeUpsert: false` で現行経路の基準値（XL 相当: UPSERT 10,000 → 事前 GET 200 + 書込 100〜101 回）を取る
- [ ] 既定（native）で再測 → **UPSERT フェーズ約 100 回・ジョブ全体 511 → 約 311 回**を確認
- [ ] 結果を `verification/scale-notes.md` に追記（日次 API 上限カウントの併記ルールで）し、エンジンへ共有

## ドキュメント・記事系

- [ ] 記事 #3 の「UPSERT の重複判定に使う事前 GET」記述に、v3.73.0 以降は native 化で消えた旨の追記を検討（公開済み記事の更新は任意・時期判断）
- [ ] 定石への 1 行: UPSERT ソースはキーが一意になる形（GROUP BY 集計）に寄せると native 適用が確実（非集約 SELECT + 重複は従来経路 fallback で遅いまま）
- [ ] `EXPLAIN` の適格性表示（ELIGIBLE / INELIGIBLE / UNKNOWN）をテンプレート CLAUDE.md の検証手順に足すか判断
