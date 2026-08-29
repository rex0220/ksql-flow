# コードレビュー: M1-d（KF-04 耐久 EXECUTION_STARTED）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §7。実施順は KF-03 と入替え — 起票の表を修正済み）
- 対象: `src/logapp.ts`（markExecutionStarted）・`src/executor.ts`（durableExecutionStarted パラメータと挿入点）・`src/commands/run.ts`・`test/__tests__/orchestrator_run.test.ts`・`test/helpers/mockKintone.ts`（PUT revision 検査）

## 実行したテスト・確認

- `npm test`: **19 suites / 240 tests 全 green** / `npm run typecheck`・`npm run build`: 成功
- シーケンス実証: JOB レコード UPDATE（成功確認）→ JSONL `execution_started` → SQL 開始の順序、JOB 値・結果 `startedAt`・JSONL の三点一致（kintone DATETIME 精度へ ms 正規化）
- fail-closed の実証: UPDATE 失敗時に**データ読取 API を発行せず** `LOCK_UNAVAILABLE / Exit 3 / executionStarted=false` の結果 JSON（リクエスト列で検証）。runJob の finally 経由で JOB レコードは FAILED 終端・job_key 解放（ロック残留なし）
- 応答消失: 再 GET で自分の書込値を確認できれば続行、確認不能なら SQL 未実行で fail-closed — 両分岐テストあり
- **revision 方式（§13 決定）**: エンジン v3.74.0 の公式 `putRecords` が `revision?: number` を kintone へ透過することを確認し、expected revision 1（acquireLock INSERT 直後のため）の楽観ロック付き UPDATE を採用。競合は 409 → 再 GET 照合 → 不一致なら fail-closed。mock も revision 409（GAIA_CO02）を実装し FlowNet 実測挙動と整合
- standalone: `runner_execution_started_at` UPDATE を発行しないことをテストで検証。checkpoint の握り潰し経路を使用していない
- M1-c 指摘 1（getFields 失敗時メッセージ）修正済み

## 指摘

### 指摘 1: markExecutionStarted が writableFields 経由でフィールド欠落時に無音の no-op になり得る
- 重大度: MINOR（現状は到達不能）
- 観点: B / 該当: `src/logapp.ts` markExecutionStarted の `writableFields({runner_execution_started_at})`
- 内容: フィールドが存在しない場合 compatible が空になり PUT が実質 no-op で成功扱いになる。orchestrator 経路は requireFields で存在を保証済みのため現状到達不能だが、呼出し前提が崩れると耐久化スキップが検出できない
- 期待値: compatible にフィールドが残っていなければ throw する 1 行ガード。次回変更時で可

### 指摘 2: 「書込は永続化されたが確認不能」端ケースの意味論（記録要）
- 重大度: MINOR（動作は安全側・変更不要）
- 観点: A
- 内容: PUT が実際は成功・応答消失・再 GET も失敗の場合、SQL 未実行で fail-closed するため、JOB レコードに `runner_execution_started_at` が残るが有効な結果 JSON は `executionStarted=false` を返す。契約上、有効な結果 JSON が正であり矛盾しないが、完了報告へ「耐久マーカーは『SQL 開始直前まで到達』の証跡であり、有効な結果 JSON が存在する場合は結果側が正」と明記されたい

## 総合判定

**M1-d 通過**（BLOCKER/MAJOR なし）。指摘 1 は次回変更時、指摘 2 は完了報告への記録事項。
