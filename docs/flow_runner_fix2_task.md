# 差し戻し指示書 fix2: 裁定 Q1〜Q6 の反映（担当: Codex）

**日付**: 2026-08-21 ／ **根拠**: `docs/reviews/decisions.md`（裁定 Q1〜Q6・裁定者 Takashi）
**仕様の正**: `docs/ksql_flow_design_v2_6.md`（裁定反映済み。v2.5 から 3.2 / 3.3 / 5.1 / 6.3 / 7.1 / 8.1 / 8.2 / 8.5 を改訂）
**前提**: fix1（`docs/reviews/fix_response_codex-20260821.md`）適用済み・80 テスト全通過の状態からの差分作業。

実装変更は R1〜R3 の 3 件（うち R1 はテスト追加のみ）。Q1 / Q3 / Q5 は現実装が裁定どおりのため**コード変更なし**（R4 のドキュメント反映のみ）。

---

## R1（裁定 Q2）: 依存伝播のホワイトリスト化 — テスト追加のみ

* 裁定: 「依存先が実行されるのは、依存元が `SUCCESS` または `NO_DATA` で終了した場合のみ。それ以外（`FAILED` / `ABORTED` / `TIMEOUT` / `SKIPPED` / `LOCKED`）はすべて `SKIPPED`」（設計書 v2.6 §3.3）。
* 現実装（`src/commands/runAll.ts` の `FAILURE_STATUSES` + SKIPPED 判定）は挙動としてこれに一致しているはず。**確認の上、コードは原則変更せず、欠けているテストを追加する**:
  1. **LOCKED 起因の伝播**: run-all 中に依存元ジョブがロック競合（既存 RUNNING レコードとの `job_key` 衝突）で `SKIPPED (LOCKED)` になったとき、依存先が `SKIPPED` になること。集約 Exit は 5（10.3）。
  2. TIMEOUT 起因の伝播: 依存元 `TIMEOUT` → 依存先 `SKIPPED`（既存テストに無ければ追加）。
* 判定ロジックを触る場合は、ホワイトリスト形式（`SUCCESS` / `NO_DATA` のみ通す）への書き換えを歓迎する（挙動不変であること）。

## R2（裁定 Q4）: リトライ対象へ 504 / 522 / 524 を追加

* `src/http.ts` の `RETRYABLE_STATUS` に **504, 522, 524** を追加（429 / 500 / 502 / 503 / 520 は維持。「5xx 全般」へは広げない）。
* テスト: `test/__tests__/http.test.ts` に 504（および 522 か 524 のどちらか）がリトライされること、**501 がリトライされない**ことを追加。

## R3（裁定 Q6）: 選抜実行の `SKIPPED (filtered)` 記録と resume の選抜規則

* `--from` / `--only` の選抜実行で、**選抜外ジョブに `SKIPPED`（理由 filtered）の JOB レコードを記録**する（`src/commands/runAll.ts`。既存の `recordSkipped` 相当を流用してよい）。
* **必須条件**（decisions.md Q6 の確認条件）:
  * (a) filtered レコードは `job_key` を持たない（`insertRecord` 経由 = ロック非関与のまま）
  * (b) filtered は依存伝播・通知・Exit 集約（10.3）のいずれからも中立: `aggregateExit` で 5 として扱わない／依存判定上は満たされたものとして扱う（現行の「選抜外 = 満たされた扱い」を維持）／onFailure 通知の失敗ジョブ一覧に載せない
* **resume の判別（実装ノート — 必読)**: 現行 `LogAppClient.listBatchJobs()` は `script_name` と `status` しか取得しないため、**failure 起因の `SKIPPED` と filtered を判別できない**。判別手段を実装すること。推奨: `listBatchJobs` の取得フィールドに `log_detail` を加え、`SKIPPED (filtered)` で始まるレコードを resume の再実行対象（`RERUN_STATUSES`）から除外する（filtered は `priorSuccess` にも入れない — 依存判定は「選抜外扱い」の現行経路で満たされる）。log_detail 以外の確実な判別手段（例: `error_message` へのマーカー）を選ぶ場合は fix 回答に理由を記すこと。
* **resume の再実行対象**（設計書 v2.6 §6.3）: `FAILED` / `ABORTED` / `TIMEOUT` / `SKIPPED`（失敗起因）/ `RUNNING` + **JOB レコードが存在しないジョブ**（未着手）。
* テスト:
  1. `--only` 実行後の直近バッチに filtered レコードが残り、`job_key` が空であること
  2. その直後の `--resume` が **filtered ジョブを再実行しない**こと（fix1 で入った「レコード不在 = 再実行」との両立を確認）
  3. filtered が Exit 集約に影響しないこと（`--only` で対象ジョブ成功 → Exit 0）

## R4（裁定 Q1 / Q3 / Q5）: ドキュメント反映のみ

* `README.md`:
  * heartbeat は Exit 0 完了（`NO_DATA` 含む）で送信することを明記（Q1。既に近い記述があるため裁定確定の旨に揃える）
  * 「ログアプリと排他制御」節に **kintone 通知レシピの 2 条件方式**を追記（Q5）: ①`record_type = BATCH` かつ FAILED 系、②`record_type = JOB` かつ `parent_batch_id` が空 かつ FAILED 系
  * 制限事項の `last_written_key` 記述を「裁定 Q3 で期限付き容認（E-1 解消で差し替え）」に更新
* コード変更は不要（現実装が裁定どおり）。

## 完了条件

1. `npm test` 全通過（既存 80 件 + 追加分）・`npm run build` 成功
2. `../kintone-sql-tools` は変更禁止・エンジン依存は `/flow` 公式 API のみ（従来どおり）
3. 対応要約を `docs/reviews/fix_response_codex-20260821.md` に「fix2」節として追記（R 番号ごとに修正方法・変更ファイル・追加テスト名。R3 の判別手段の選択理由を含める）
