# kSQL-Flow から kSQL-FlowNet への返信: M1 Execution Contract v1 への疑義（実装前）

- 日付: 2026-08-30
- 状態: **クローズ（2026-08-30 裁定受領。文末の追記を参照）**
- 返信元: kSQL-Flow（Execution Plane、本リポジトリ）
- 返信先: kSQL-FlowNet（Control Plane）
- 対応する依頼: `docs/kSQL-FlowNetからの依頼-20260829-M1-ExecutionContract.md`
- 趣旨: 実装着手前に、契約 v1 と現行実装・公開仕様の食い違い 1 件の再審議を依頼する（「コードに合わせて仕様を黙って直さない」原則どおり）。あわせて解釈確認 1 件と、契約 §13 未決事項に対する実装時決定の予告を送る。

## 疑義 1（ブロッカー）: 実行時 SQL エラーの Exit Code と `SQL_ERROR` の定義

### 事実関係

契約 §4.2 は `SQL_ERROR`（実行時 SQL エラー）を **status FAILED / Exit 3** と定義し、変更点一覧 §3 も「SQL 実行エラー → SQL_ERROR → 3」と対応付けている。draft schema の `allOf` も同じ制約を持つ。

しかし現行 kSQL-Flow は、リリース版仕様書 `docs/ksql_flow_spec.md` 7.1 のとおり:

> SQL 構文・検証エラー … 事前検証**または実行時に**即時中断 … `FAILED` (Exit 1)

であり、実装（`src/errors.ts` `classifyRuntimeError()`）も「HTTP／ネットワーク／認証／リトライ上限／API 上限 → Exit 3、**それ以外（SQL 構文・検証・実行時 SQL エラー）→ Exit 1**」と分類している。つまり:

- SQL の最初の文を開始した**後**に発生する SQL 実行時エラー（存在しないフィールド、updateKey 制約違反の実行時検出等）は **Exit 1** で終了する。これは公開済み仕様であり、Exit Code 維持（再割当てなし）は本依頼の受入条件でもある。
- 一方、契約 §4.2 は Exit 1 に対応する resultCode を `VALIDATION_ERROR` のみとし、`VALIDATION_ERROR` には `executionStarted = false` を必須としている。

したがって「`executionStarted = true` かつ Exit 1」という**現行実装に正規に存在する失敗**を、契約 v1 の安定 resultCode で表現できない。無理に `VALIDATION_ERROR` を返すと契約違反（Control Plane が UNKNOWN 化）、`SQL_ERROR` を返すと exitCode 不一致で不正結果になる。

### 提案（契約は PROPOSED のため、v1 確定前の表の修正として）

1. `SQL_ERROR` の定義を「**status FAILED / Exit 1** / 実行時 SQL エラー。`executionStarted` は最初の SQL 文への到達状況に応じた値」へ変更する。
2. `VALIDATION_ERROR` は「SQL 開始前の引数・設定・SQL 静的検証エラー（`executionStarted = false` 必須）」に限定する（現行どおり）。
3. §4.2 の Exit 3 行から `SQL_ERROR` を削除する。現行分類で Exit 3 になるのは HTTP／ネットワーク／認証／timeout／API 上限／ロック系のみであり、Exit 3 の SQL_ERROR は現実装では発生しない。
4. draft schema の `allOf`（`SQL_ERROR` を Exit 3 グループに含める条件）と fixture を同修正に追随させる。

代替案として「実行時 SQL エラーを Exit 3 へ再分類する」も検討したが、公開仕様 7.1 の変更・既存利用者の Exit 分岐（CI／スケジューラ）破壊・依頼書の互換性条件（Exit Code 維持）への抵触から推奨しない。

裁定が出るまで、KF-01（resultCode 表・JSON Schema の確定）は保留する。他 KF の裁定に依存しない部分は先行実装する。

## 確認 2: orchestrator モードのオプション必須規則

契約 §2 は `--correlation-id` / `--attempt-id` / `--expected-job-id` を「必須」、`--result-json` を「orchestrator 経由では必須」とするが、既存利用者（FlowNet 未導入）には課せない。次の解釈で実装する予定である。異議があれば返信されたい。

- 4 オプション（`--result-json` / `--correlation-id` / `--attempt-id` / `--expected-job-id`）は**いずれか 1 つでも指定されたら 4 つすべて必須**（= orchestrator モード）。欠落は VALIDATION_ERROR / Exit 1。
- 未指定（standalone）の `run` は従来どおり動作し、Execution Result を出力しない。
- `--as-of` は必須化しない（省略時は現在時刻。FlowNet は常に snapshot 値を渡す運用前提。契約 §2 の「snapshot 値と一致」検証は as-of を発行する FlowNet 側の照合責務と解釈する)。

## 予告 3: 契約 §13 未決事項に対する実装時決定（概要）

詳細は完了報告で記録するが、方向性に異議があれば早期に返信されたい。

| §13 項目 | 決定方針 |
| --- | --- |
| result-json 既存ファイル上書き | 上書きせず起動時に拒否（fail-closed。attempt ごとに新 path を渡す運用を前提） |
| executionId | 既存 batchId（UUID v4）を公開。発行時点はプロセス起動時。ログ `batch_id` と同値 |
| graceful cancel の Exit 3 互換 | 現行 Ctrl+C は Node 既定終了で契約化されておらず、CANCELLED/Exit 3 は追加であって変更ではない |
| EXECUTION_STARTED の応答消失 | 応答不明時は同一レコードを再 GET し、自分の `runner_execution_started_at` を確認できた場合のみ SQL 開始。確認不能は fail-closed |
| capability command | トップレベル `ksql-flow capabilities --json`、Exit 0。未実装機能は `false` を正直に返す |
| Windows signal | SIGINT / SIGBREAK を捕捉、SIGTERM は Windows 非対応と明記。両 OS で contract test |
| JSON Schema 配布 | kSQL-Flow リポジトリ `schema/execution-result-v1.schema.json` として同梱 |
| JOB ログ相関フィールド | template v0.4 で非必須フィールドとして追加（`correlation_id` / `attempt_id` / `execution_id` / `job_id` / `runner_execution_started_at`）。orchestrator モードは存在検査 + fail-closed、旧アプリの standalone 利用は不変更 |
| force-unlock | 対象特定型 `force-unlock-job --job-key`（停止確認・理由・確認者・証拠参照を必須入力、欠落は API 前拒否）+ 読取専用 `inspect-lock` の 2 コマンド案。既存 `unlock` は人間向けに維持 |
| describe-profile canonical JSON | 全階層キー辞書順ソート + 空白なし（RFC 8785 相当の簡易規則） |
| inspect-job 検査 code | エンジン `parseScript` 診断由来の code 一覧を実装で確定し完了報告へ記録 |

なお、FlowNet 側実測前提（job_key 64 文字上限・`job_key` 非必須前提の `finishRecord()` 方式・ドロップダウン `in` のみ）は本 M1 で維持する。J1 ロックキーへの移行は D-14 未決のため行わず、現行 `{profile}:{job_id}` を維持する（依頼書どおり）。

## 完了時の報告

疑義 1 の裁定受領後に実装を確定し、依頼書「完了時」の様式（実装内容・§13 決定事項・受入基準充足状況・Spike E 測定結果）で別途報告する。

---

## 追記（2026-08-30）: 裁定受領・クローズ

FlowNet から `docs/kSQL-FlowNetからの返信-20260830-M1疑義裁定.md`（裁定者: オーナー承認済み）を受領した。疑義 1 は提案どおり承諾（`SQL_ERROR` = FAILED/Exit 1、FlowNet 正本は ksql-flownet main `c95cbc4` で修正済み）、確認 2 は解釈に同意、予告 3 は 11 項目すべて異議なし（補足 3 点あり）。裁定内容は `docs/internal/reviews/decisions.md` Q13 と `docs/internal/flow_m1_execution_contract_task.md` へ反映済み。KF-01 の保留は解除された。
