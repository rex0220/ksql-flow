# コードレビュー: M1-a（KF-01 Execution Result 型・schema・変換表）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §3 / M1-a）
- 対象: `src/contract/executionResult.ts`・`src/contract/index.ts`・`schema/execution-result-v1.schema.json`・`test/__tests__/execution_result_contract.test.ts`・`test/fixtures/execution-result/`・`package.json`（ajv devDependency 追加）

## 実行したテスト・確認

- `npm test`: **18 suites / 216 tests 全 green**（新規 execution_result_contract.test.ts 含む）
- fixture 3 件（success/failure/sql-error）が FlowNet c95cbc4 原本と**内容同一**（差異は改行コードのみ）であることを diff で確認
- schema に `$id` + `x-contract: ksql-flow.execution/v1` を確認（裁定補足 2 対応）
- 裁定 Q13 の反映を確認: SQL_ERROR = FAILED/Exit 1、Exit 1 の判別（resultCode + executionStarted）が実装・schema・テストの三点で一致
- 既存コード無変更（変更は package.json/lock と新規ファイルのみ）・エンジンリポジトリ無変更・既存挙動への配線なし（M1-b 予定どおり）
- 秘密情報: error.message は masker 必須引数 + SQL カテゴリで stripSqlLiterals + 2,000 字切詰め。テストで漏えいなしを確認
- ajv ^8.17.1（MIT・devDependency・テストのみで使用）は妥当

## 指摘

### 指摘 1: canonical schema が契約 §3.3/§4.2 より 4 点厳格（記録要）
- 重大度: MINOR（変更不要・完了報告へ記録）
- 観点: A
- 内容: (a) `lastSuccessfulChunkNo`/`lastWrittenKey` を required へ追加（契約では診断情報）、(b) `executionStarted=false` で count 類 const 0、(c) `LOCK_UNAVAILABLE` に executionStarted=false を要求（契約は VALIDATION_ERROR/LOCK_CONFLICT のみ必須）、(d) resultCode ごとに error.category を const 固定
- 判定: いずれも起票 §3 の変換表・「未開始は 0/null」の指示どおりで、producer（本ランナー）側 schema としては安全側。ただし FlowNet 検証コピー（draft）との差分になるため、**完了報告の §13 決定事項に「正本 schema は契約より厳格な producer 制約を含む」旨を明記すること**（M1-h）

### 指摘 2: VALIDATION_ERROR の category が CONFIG 固定
- 重大度: MINOR
- 観点: A
- 内容: SQL 静的検証（parse）エラーも category CONFIG になる。`ExecutionErrorInput.code` は上書き可能なので、M1-b 配線時に parse エラーへ KSQL13xx 等の診断 code を渡すこと。category の粒度が問題になれば additive 追加で対応（schema は category を open string 維持済み）

### 指摘 3（M1-b への申し送り）: 事前失敗時の jobId
- 重大度: MINOR（M1-a 範囲内は問題なし）
- 観点: C
- 内容: `jobId` は `outcome.jobName` 由来で空を例外にする。SQL ファイルを load できない controlled failure では JobOutcome が存在しないため、M1-b では `--expected-job-id` を jobId とする合成 outcome の構築が必要。また事前失敗の apiCalls=0（ロック取得の実消費を含めない）は起票どおりの意識的決定として完了報告へ記録

## 総合判定

**M1-a 通過**（BLOCKER/MAJOR なし）。指摘 1・3 は完了報告への記録事項、指摘 2 は M1-b 実装時の考慮事項。

補記: Codex 実行はワークスペースのクレジット切れで終了報告が途切れたが、成果物は完備しテストは全 green。次マイルストーン着手にはクレジット追加が必要。
