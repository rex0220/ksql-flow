# コードレビュー: M1-e（KF-03 capabilities / describe-profile / inspect-job）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §5 / M1-e + M1-d レビュー指摘 1）
- 対象: `src/commands/capabilities.ts`・`describeProfile.ts`・`inspectJob.ts`・`machineJson.ts`・`src/cli.ts`・`src/contract/executionResult.ts`（EXECUTION_RESULT_SCHEMA_ID）・`src/logapp.ts`（no-op ガード）・`docs/ksql_flow_spec.md` 10.1・テスト 3 ファイル

## 実行したテスト・確認

- `npm test`: **20 suites / 258 tests 全 green** / `npm run typecheck`・`npm run build`: 成功
- **秘密非混入の構造的保証**（最重要観点）: `describe-profile` は ResolvedProfile を spread / serialize せず、許可フィールドだけを新規 object へコピーする allowlist 方式（起票の denylist 禁止要件どおり）。token/password/basicAuth 等 6 種の秘密値が出力へ文字列非出現であることをテストで検証
- canonical JSON: 全階層キー辞書順ソート+空白なし+末尾 LF（`machineJson.sortJsonKeys`、配列順序は維持）。決定性（同一入力同一バイト）をテストで検証 — §13「canonical 正規化規則」の実装確定
- `capabilities`: config・通信不要、`gracefulCancel: false`（正直な申告）、`durableExecutionStarted: true`、`jobLockProtocol: "profile-job-v0"`、同梱 schema の `$id`+contract を `resultSchema` で公開（裁定補足 2 対応）
- `inspect-job`: エンジン公開診断 code を無改変で公開。**通信ゼロ**（3 コマンドとも fetch 0 回をテストで検証）で `validateScript` により semantic 診断（KSQL1305/1306 等）まで取得する設計。出力の path は fileName（basename）のみで絶対 path を含まない（契約 §10）
- **D-23 材料（完了報告へ転記）**: エンジン v3.74.0 公開診断 code は KSQL1001〜1006 / 1101 / 1201〜1203 / 1301〜1306。非決定要素に分類するのは `KSQL1306`（@なし時刻関数）のみ。`KSQL1305`（素の INSERT 冪等性警告）は診断に含めるが非決定要素に分類しない。schema 依存の `KSQL1302`/`KSQL1303` は通信なし検査では検出不能（検出済みと偽らない）。乱数・外部状態参照は対応する公開診断 code がなく未検出扱い
- M1-d 指摘 1（markExecutionStarted の no-op ガード）解消を確認。公開仕様 10.1 へ 3 コマンド追記済み

## 指摘

なし（BLOCKER/MAJOR/MINOR とも新規指摘なし）。

## 総合判定

**M1-e 通過**。D-23 材料と KSQL1302/1303 の検出限界は完了報告へ記載する（FlowNet の「未承認の非決定要素拒否」は静的検査の限界を踏まえた運用になる）。
