# docs/internal — 開発経過の記録

開発プロセスの記録（タスク指示書・レビュー往復・エンジンとの申し送り・実機検証・旧版設計書）を置く。
**利用者向けドキュメントは [README](../../README.md) と [仕様書（リリース版）](../ksql_flow_spec.md) を参照。**

as-is 公開方針（設計書 15.1）に基づき、本ディレクトリも公開対象（開発過程の透明性は信頼材料）。
秘密情報（実ドメイン・トークン・個人情報）は一切含めない規約で運用している（検証記録 §1）。

## 開発メモ

エンジンを隣接作業ツリーで結合確認する場合のみ `npm run dev:engine-local` で `file:../kintone-sql-tools` を node_modules へ一時適用する（package.json / package-lock.json はレジストリ参照 `^3.77.0` のまま）。通常の開発・CI はレジストリ版を使う。B179先行buildは公開APIを含んでもversion exportが3.76.0のため、結合テストはversion文字列ではなくexport関数の存在で判定する。

## 構成

| 分類 | ファイル |
| --- | --- |
| タスク指示書 | `flow_runner_task.md`（初期実装 M1-M7）/ `flow_spec_review_task.md` / `flow_code_review_task.md` / `flow_runner_fix2_task.md`（裁定反映）/ `flow_runner_fix3_task.md`（v3.70.0 対応）/ `flow_dryrun_task.md`（fix4 dry-run 本実装）/ `phase0_verification_task.md`（実機検証） |
| 調査・完了報告 | `flow_runner_survey_20260821.md`（実装前調査 §4）/ `flow_runner_report_20260821.md`（M1-M7 完了報告） |
| レビュー往復 | `reviews/` — コードレビュー・修正回答・**裁定ログ `reviews/decisions.md`（Q1〜Q7）** |
| エンジンとの申し送り | `kSQLエンジンからの申し送り-*`（v3.69.0 / v3.70.0 / v3.71.0）/ `kSQLエンジンからの設計提案-E2-*` / `kSQL Flowからの*`（E2 回答・fix4 完了報告） |
| リリース | `release_checklist_v0_1_0.md`（公開チェックリスト）/ `release_verification_v0_1_0.md`（Phase 0 実機検証記録 — 実機限定バグ 3 件の検出記録を含む）/ **v0.1.0 は 2026-08-22 公開完了**（GitHub / Release / npm） |
| 設計書（開発版・旧版） | `ksql_flow_design_v2_5.md` 〜 `v2_9.md`。**開発経緯・改訂履歴・裁定参照付きの正本は `v2_9`**。リリース版（履歴除去済み）は [`../ksql_flow_spec.md`](../ksql_flow_spec.md) |
