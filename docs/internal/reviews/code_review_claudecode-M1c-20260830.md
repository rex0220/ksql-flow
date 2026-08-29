# コードレビュー: M1-c（相関 ID ログ伝播・ログアプリ template v0.4・旧 schema 互換）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §6 / M1-c + M1-b レビュー指摘 1・3）
- 対象: `src/logapp.ts`（fieldSupport 一般化・requireFields・相関 5 フィールド・CANCELLED 選択肢）・`src/executor.ts`（correlation → baseFields・writeChunks 伝播）・`src/runner.ts`/`src/logging/jsonl.ts`（JSONL 相関）・`src/commands/run.ts`/`src/cli.ts`・`template/`・テスト 6 ファイル

## 実行したテスト・確認

- `npm test`: **19 suites / 235 tests 全 green**（+4。standalone 回帰含む）
- `npm run typecheck` / `npm run build`: 成功
- **fail-closed の実証**（最重要観点）: 旧 schema アプリでの orchestrator 実行は、getFields 1 回だけを発行し**レコード書込 0 件・SQL 未実行**で `LOCK_UNAVAILABLE / Exit 3 / executionStarted=false` の結果 JSON を出力（テストで API リクエスト列を厳密照合）
- 旧 schema 互換: 同じ旧アプリで standalone は従来どおり完走（JOB レコードに相関フィールドなし・JSONL に相関キーなし を明示的に検証）
- `requireFields` は引数検証・job load 後かつ**ローカルロック取得前**に実施。getFields は Promise キャッシュで 1 回（テストで回数検証）
- getFields 失敗時: standalone は従来フィールド集合で書込続行（旧挙動同等）、orchestrator は error を fail-closed へ昇格 — 「判定失敗で全書込が堕ちない」旧設計の保証を維持
- 相関値: JOB レコード（correlation_id / attempt_id / execution_id=batchId / job_id=論理名）と JSONL 全イベント（correlationId / attemptId / executionId）をテストで全件検証
- `lastSuccessfulChunkNo`: 書込 1 chunk で実値 1、書込ゼロ・未開始で null（M1-b 指摘 1 解消）
- `writeOrchestratorStartupFailure` に masker 引数を追加し、profile 解決済み呼出し箇所で実 SecretMasker を使用（M1-b 指摘 3 解消）。stderr 出力にも mask 適用
- template v0.4: 相関 5 フィールド追加（全て非必須・重複禁止なし）、`job_key` の unique 維持、status へ CANCELLED 追加。template_contract テストで ZIP 実体（3 entries / 46 fields）と LOG_APP_FIELDS の整合を検証
- 未実施（実装報告どおり）: 実 kintone へのテンプレート取込と 128 文字相関 IDの受理確認 — **M1-h の実機検証項目として残す**（起票 §6-1）

## 指摘

### 指摘 1: getFields 失敗時の情報メッセージが実態より狭い
- 重大度: MINOR
- 観点: C / 該当: `src/logapp.ts` fieldSupportResult の catch 内メッセージ
- 内容: 「deleted_count は送信しません」と表示するが、実際は相関フィールドも送信対象外になる
- 期待値: 「任意フィールド（deleted_count・相関フィールド）は送信しません」等、実態に合わせた文言。次回変更時で可

## 総合判定

**M1-c 通過**（BLOCKER/MAJOR なし、MINOR 1 件は文言のみ）。M1-b 指摘 1・3 の解消を確認。実機検証残（テンプレート取込・128 文字 ID）は M1-h へ引き継ぐ。
