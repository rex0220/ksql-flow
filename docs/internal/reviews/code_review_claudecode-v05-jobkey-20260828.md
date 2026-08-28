# コードレビュー — v0.5 job_key 入力ガード（Claude Code）

* 対象: `src/jobkey.ts`（新規）・`validate.ts` / `run.ts` / `runAll.ts` の統合・テスト 2 ファイル・CHANGELOG（Codex・2026-08-28）
* 起票: `flow_v05_jobkey_guard_task.md` ／ 実測入力: 上限 64・UTF-16 単位 = JS `.length` 一致（2026-08-28 実機）
* 判定: **承認（指摘なし）**

## 検証

* `npm test` 170/170（既存 160 + 新規 10）・`npm run typecheck` OK — 当方でも再実行して確認
* `buildJobKey` / `buildBatchJobKey` に集約され、**素の連結が src から消えた**（grep で残存ゼロ。runAll は `jobKeys.get` / `batchKey` を使用）
* 検査タイミング: 3 コマンドとも設定読取後・API 前で ConfigError → Exit 1（runAll は選抜前に全ジョブ検査 = fail-fast）
* 検査内容: `__batch__` 予約（バッチキー生成側だけ内部許可）・`:` を profile / ジョブ名の両側で拒否・完成キー 64 上限（実測出典コメントつき）
* 境界テスト: 64 OK / 65 NG・サロゲートペアで `.length` 基準の判定・バッチキー側の上限超過はプロファイル名短縮を促す別文言
* エラーメッセージ: 原因 + 対処（@ksql name / config の変更先）を明示 — 起票要件どおり
* CHANGELOG `[0.5.0] - Unreleased` に移行案内（v0.4 で動いた名前が Exit 1 になる旨と対処）
* キー形式は不変（移行期間の二重実行問題なし）・version は 0.4.1 のまま（リリース判断は別）

これで討論（`lock_design_debate-20260828.md`）が特定した**唯一の確定コード欠陥**が解消。凍結項目（心拍化ほか）への越境なし。
