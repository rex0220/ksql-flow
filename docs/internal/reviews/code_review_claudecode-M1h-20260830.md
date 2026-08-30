# コードレビュー: M1-h 机上パート（指摘対応・残契約試験・CHANGELOG/README・完了報告ドラフト）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §10〜§12 / M1-h）
- 対象: `src/executor.ts`（cancelled_with_error JSONL）・`src/logapp.ts`（409 後の監査内容照合・listRunning fields）・テスト 5 ファイル（+5 tests）・`CHANGELOG.md`・`README.md`・`docs/ksql_flow_spec.md`・起票 §12 更新・完了報告ドラフト

## 実行したテスト・確認

- `npm test`: **22 suites / 286 tests 全 green** / typecheck・build: 成功
- M1-g 指摘 1 解消: 409 競合後に job_key 不在の場合、同一 record の `job_key_done` と `log_detail`（自分の監査 JSON 全文）一致時のみ RELEASED、不一致は NOT_RUNNING（他者解放）。「自 PUT 適用+応答喪失」と「他者解放」を監査内容で判別する設計は妥当
- M1-g 指摘 2 解消: listRunning の fields へ `$revision`/`host`/`script_name` 追加
- M1-f 指摘 1 解消: signal 同時エラーを JSONL `cancelled_with_error`（code・message・cause chain、SecretMasker 適用）へ記録。結果 JSON は CANCELLED 優先のまま
- 追加契約試験: stdout EPIPE が path 出力に干渉しない・stdout 書込失敗でも実行本来の Exit 維持・additive unknown field の schema 受理 — いずれも実効的
- CHANGELOG（Unreleased/v0.7.0 予定）と README のコマンド・フラグ追随は実装と一致。過大な記述なし
- 完了報告ドラフト: §13 確定 15 項目・force-unlock 契約・D-22/23/26 材料・受入基準の全 16 項目評価（FlowNet 正本が 14→16 項目へ増えていた点を注記付きで吸収 — 欠落防止として適切）。レビューで実機検証記録（項目 1 合格）を反映済み

## 指摘

なし（BLOCKER/MAJOR/MINOR とも新規なし）。過去レビューの持ち越し MINOR はすべて解消（M1-b 指摘 2 と M1-d 指摘 2 は決定として完了報告へ記録済み）。

## 総合判定

**M1-h 机上パート通過**。残タスクは実機検証のみ: (2) check-logapp、(3) 128 文字 ID、(4) orchestrator E2E（EXECUTION_STARTED・結果 path・lock 回復）、(5) Windows 実コンソール signal、(6) Unix signal。完了後に本報告を確定版へ更新し、オーナー承認を経て FlowNet へ送付する。
