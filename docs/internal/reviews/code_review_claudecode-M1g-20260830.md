# コードレビュー: M1-g（KF-06 inspect-lock / force-unlock-job）

- 日付: 2026-08-30 / レビュー: Claude Code / 実装: Codex（`flow_m1_execution_contract_task.md` §9 / M1-g）
- 対象: `src/commands/lockRecovery.ts`・`src/logapp.ts`（forceUnlockJob / findByRecordId / RunningRecord 拡張）・`src/cli.ts`・`docs/ksql_flow_spec.md`・起票 §9 の決定反映・テスト 2 ファイル

## 実行したテスト・確認

- `npm test`: **22 suites / 281 tests 全 green** / typecheck・build: 成功
- fail-closed 順序: 必須入力欠落（--reason/--confirmed-by/--evidence-ref、evidence-ref の絶対 URI 検証含む）は **API 呼び出し 0 件**で Exit 1（FlowNet Spike F と同順序）
- 解除の安全性: 検索時 identity（record id・batch_id・job_key）を record-id GET で再確認し、その **revision を固定した単一 UPDATE**（M1-d と同方式）。競合は 409 → CONFLICT / Exit 5 でレコード不変をテスト検証
- 応答消失: PUT 応答消失 → job_key 再 GET でクリア確認時のみ RELEASED、確認不能は UNCONFIRMED / Exit 3 + `nextAction`（inspect-lock 再照会）— 両分岐テストあり
- 監査: `log_detail` 先頭 `LOCK_RECOVERY` + JSON（reason/confirmedBy/evidenceRef/authenticationSubject=profile/executedAt）。status は選択肢追加を避け **FAILED**（自動 stale 回収の TIMEOUT と判別可能）— §13 決定として妥当、起票 §9 へ反映済み
- 対象限定: 該当 job_key の RUNNING 1 件のみ。既存 `unlock` / `--force-unlock`（profile 全 RUNNING）の挙動不変を回帰テストで確認
- stdout 純度: 両コマンドとも JSON object 1 個+LF。inspect-lock は照会不能時も JSON（`LOCK_QUERY_UNAVAILABLE`）+ Exit 3
- Exit 対応（§13 決定）: RELEASED=0 / NOT_FOUND・NOT_RUNNING=0（照会は成功・解除対象なし）/ 入力不備=1 / UNCONFIRMED=3 / CONFLICT=5

## 指摘

### 指摘 1: 409 競合後の再 GET で job_key 不在時に RELEASED と報告する
- 重大度: MINOR（ロック解放という目的状態は成立・安全側）
- 観点: A / 該当: `src/logapp.ts` forceUnlockJob の catch 内 `after === null → RELEASED`
- 内容: PUT が 409（他者が先に終端更新）で失敗し、再 GET で job_key が消えていた場合、実際には**自分の監査 UPDATE は載っていない**のに RELEASED を返す。ロックは解放済みだが、kintone 側 log_detail に本操作の監査 JSON が残らず、FlowNet 監査相関が不正確になり得る
- 期待値: 409 起因で after=null の場合は `NOT_RUNNING`（他者解放）等へ分類するか、RELEASED に `auditRecorded: false` 相当の区別を付す。M1-h で対応

### 指摘 2: listRunning のクエリ fields が RunningRecord 拡張に未追随
- 重大度: MINOR
- 観点: C / 該当: `src/logapp.ts:541` の `fields` 配列（`$revision`/`host`/`script_name` 欠落）
- 内容: listRunning 経由の RunningRecord は revision=0・host/scriptName 空になる。現利用者（unlock 系）は未使用のため実害なしだが、誤って forceUnlockJob へ渡すと revision 0 PUT で常に 409（安全側）になる紛らわしさが残る
- 期待値: fields へ 3 項目を追加。M1-h で対応

## 総合判定

**M1-g 通過**（BLOCKER/MAJOR なし、MINOR 2 件は M1-h で対応）。KF-01〜KF-06 の実装が揃った。残るは M1-h: 指摘対応・契約試験の残り（stdout pipe 切断等）・CHANGELOG/README・完了報告ドラフト・実機検証（テンプレート v0.4 取込・128 文字 ID・Windows/Unix signal・実 kintone での orchestrator E2E）。
