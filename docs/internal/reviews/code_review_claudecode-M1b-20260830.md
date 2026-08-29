# コードレビュー: M1-b（KF-02 CLI 4 フラグ・stdout 規律・atomic 書込・controlled failure）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §2・§4 / M1-b）
- 対象: `src/cli.ts`・`src/commands/run.ts`（orchestrated 経路分離）・`src/contract/executionResultWriter.ts`・`src/executor.ts`（onExecutionStart/onExecutionError フック）・`src/runner.ts`（orchestrator 時 out→stderr）・`test/__tests__/orchestrator_run.test.ts`・`test/__tests__/cli_contract.test.ts`

## 実行したテスト・確認

- `npm test`: **19 suites / 231 tests 全 green**（既存 216 + 新規 15。run/run-all/dry-run 回帰含む）
- `npm run typecheck` / `npm run build`: 成功
- stdout 純度: `--result-json -` で stdout write 1 回・BOM なし・JSON object 1 個+LF のみをバイト検証（人間向け出力は stderr へ）
- atomic 書込: 一時ファイル(wx, 0600)→fsync→rename の順序をモック FS で実証。失敗時の一時ファイル掃除・rename 直前の再存在チェック（Windows の rename 上書き差異対策）あり
- fail-closed: 既存出力先は **API 呼び出し 0 件**で Exit 1・既存内容不変。expected-job-id 不一致・logApp 未設定も API 前拒否をテストで実証
- Exit 一致: ASSERT(2)/API(3, KINTONE_HTTP_500)/LOCK_CONFLICT(5) で JSON exitCode = プロセス Exit を確認。単一ソース（`result.exitCode` を return）
- standalone 分離: `runStandaloneCommand` は旧実装そのまま。orchestrator フラグ未指定時の挙動・出力・API 消費は不変更
- 秘密情報: orchestrated 経路は env.masker/fallbackMasker を通す。M1-a 申し送り 2 件（parse 診断 code → error.code、load 不能時 jobId=expected-job-id）反映済み
- notify は内部 catch 済み（`src/notify.ts:79,102`）で、通知失敗が SUCCESS 結果や Exit を上書きしない

## 指摘

### 指摘 1: `lastSuccessfulChunkNo` が常に null（起票 §3 未達）
- 重大度: MINOR
- 観点: A / 該当: `src/commands/run.ts`（normalizeJobOutcome 呼出しの `lastSuccessfulChunkNo: null` 固定）
- 根拠: 起票 §3「lastSuccessfulChunkNo = 既存 writeChunks 相当」。runJob 内部の `writeChunks` が出力境界へ渡っていない
- 期待値: JobOutcome または観測フックで chunk 数を伝播し、書込があった実行では数値を返す。診断情報のため nullable で契約違反ではない — **M1-c 実装時に併せて対応**

### 指摘 2: ID 形式不正時は Execution Result を出力しない（決定として記録要）
- 重大度: MINOR（動作は安全側）
- 観点: A
- 内容: `--correlation-id` 等が文字クラス違反の場合、`orchestratorOptionsFromArgs` が null を返し JSON なし・stderr+Exit 1 で終了（FlowNet 側は UNKNOWN）。不正 ID の echo は契約 §10 のログインジェクション対策と衝突するため妥当な選択
- 期待値: 完了報告の §13 決定事項へ「ID 不正時は結果 JSON を出力しない（echo による注入を避ける）」を明記

### 指摘 3: startup failure 経路の masker が恒等関数
- 重大度: MINOR
- 観点: B
- 内容: `writeOrchestratorStartupFailure` は profile 解決前のため SecretMasker を構築できず `mask: v=>v`。現状この経路の message は引数検証・config 検証エラーのみで秘密を含まないが、profile 解決済みの呼出し箇所（`-f` 欠落）では実 masker を渡せる
- 期待値: 可能な箇所では実 masker を渡す。M1-c 以降の変更時に併せてで可

## 総合判定

**M1-b 通過**（BLOCKER/MAJOR なし）。指摘 1 は M1-c で対応、指摘 2 は完了報告へ記録、指摘 3 は次回変更時に改善。

§13 決定の追加分（完了報告用）: 出力先の起動時存在チェックは cli 検証と run 経路の二重で行い、race 対策として rename 直前にも再チェック。executionId は orchestrated 経路冒頭で発行し batchId と同値。
