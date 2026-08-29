# コードレビュー: M1-f（KF-05 signal / graceful cancel）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §8 / M1-f）
- 対象: `src/cancellation.ts`（withGracefulCancellation / CancelledError）・`src/executor.ts`（cancel 境界 4 点）・`src/commands/run.ts`（配線・順序再構成）・`src/contract/executionResult.ts`（CANCELLED status 変換）・`src/types.ts`・`src/commands/capabilities.ts`（gracefulCancel: true）・`docs/ksql_flow_spec.md` 10.3・テスト 3 ファイル

## 実行したテスト・確認

- `npm test`: **21 suites / 268 tests 全 green**（cancellation 専用 9 件含む）/ typecheck・build: 成功
- cancel 境界の実証: SQL 開始前（executionStarted=false・CANCELLED/Exit 3・SQL 未実行）、文間（次の文を開始しない）、write chunk 間（完了 chunk を checkpoint 確定後に以後の書込 API 未発行）、進行中 request は完了待ち — いずれもテストで検証
- 処理順序: runJob 内で finishRecord(CANCELLED)+JSONL 確定 → ローカルロック解放 → 結果出力（契約 §7「ロック解放前に結果とログを確定」の kintone 側確定を満たす）
- handler 寿命: run 実行中のみ登録・finally で必ず解除（cancel 後の別 run が影響を受けないことをテスト）。dry-run は登録対象外で従来挙動維持。run-all 対象外・従来挙動（spec に明記）
- 2 回目 signal: `process.exit(3)` の forced termination（結果 JSON 非保証を spec に明記）
- 通知: CANCELLED は onFailure 非送信・heartbeat は `always` のみ（テストで検証、§13 決定として完了報告へ）
- 旧ログアプリで CANCELLED 選択肢がない場合は既存 pending 退避（結果 JSON と Exit に影響なし）
- capabilities の gracefulCancel を true へ（実装完了に伴う正直な更新）
- **OS 実測の範囲**（実装報告どおり）: Windows/Node v24 の `process.emit` によるシミュレーションのみ。**実コンソールからの Ctrl+C / CTRL_BREAK 配送と Unix(SIGTERM) 実測は未実施 — M1-h の実機検証項目**（受入基準 14「Windows と Unix で signal／forced kill 試験を実施する」は本マイルストーンでは未充足）

## 指摘

### 指摘 1: signal 受信と同時に発生した真の失敗が CANCELLED に分類され元エラーが失われる
- 重大度: MINOR（安全側・記録要）
- 観点: C / 該当: `src/executor.ts` catch 節の `error instanceof CancelledError || cancellationRequested(...)`
- 内容: graceful signal 後に進行中 request が API エラーで終わった場合も status CANCELLED・メッセージ「キャンセルしました」になり、元エラーの分類・文言が結果に残らない。「停止を確認できれば CANCELLED」という契約の読みとしては妥当で安全側
- 期待値: 完了報告へ決定として記録（可能なら元エラーを JSONL に残す改善を M1-h で検討）

## 総合判定

**M1-f 通過**（BLOCKER/MAJOR なし）。実 OS の signal 配送試験（Windows コンソール実測・Unix/docker）は M1-h の実機検証で必ず実施すること — これが完了するまで受入基準 14 は開いたまま。
