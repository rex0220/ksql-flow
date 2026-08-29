# kSQL-FlowNetからの依頼: M1 Execution Contract v1の実装(Phase 0)

- 日付: 2026-08-29
- 依頼元: kSQL-FlowNet(Control Plane、`C:\Users\rex02\Projects\ksql-flownet`)
- 依頼先: kSQL-Flow(Execution Plane、本リポジトリ)
- 目的: kSQL-FlowNetから`ksql-flow`を安全にsubprocess起動するための、version付きCLI契約(Execution Contract v1)の実装
- 進め方: 本リポジトリ側で検討・実施。仕様への疑義・変更提案は本文書と同形式の返信文書で(慣行どおり)

## 正本(すべてksql-flownetリポジトリ側。実装前に必読)

| 内容 | パス |
| --- | --- |
| CLI境界契約(引数、Execution Result、Exit、signal、耐久EXECUTION_STARTED) | `C:\Users\rex02\Projects\ksql-flownet\docs\execution-contract-v1.md` |
| kSQL-Flow側の変更点一覧とPhase 0受入基準(14項目) | `C:\Users\rex02\Projects\ksql-flownet\docs\current-ksql-flow-changes.md` |
| 判断記録(D-22/D-23/D-26等。D-08/D-10/D-11/D-29はDECIDED済み) | `C:\Users\rex02\Projects\ksql-flownet\docs\phase1-freeze-decision-record.md` |
| Execution Result Schema草案(P0-00)+fixture | `C:\Users\rex02\Projects\ksql-flownet\spikes\e-execution-contract\execution-result-v1.draft.schema.json`、`tests\fixtures\execution-result\` |
| Spike E検証項目(実装と並行して閉じる) | FDR §10 Spike E |

原則: 仕様と実装が食い違う場合はコードに合わせて仕様を黙って直さず、FDR/契約文書の再審議を依頼書・返信で行う。

## 依頼する実装(推奨順は current-ksql-flow-changes.md §8)

1. **KF-01**: Execution Result型・JSON Schema・安定`resultCode`の確定(草案schemaを出発点に。resultCodeは閉じたenumにしない — 契約§4.3のadditive互換)
2. **KF-02**: `--result-json <path|->`、`--correlation-id`、`--attempt-id`、`--expected-job-id`。stdout純JSON規律、atomic rename、controlled failure時の結果出力
3. **KF-03**: `capabilities --json`、`describe-profile --json`(秘密除外・canonical JSON)、`inspect-job --json`(論理jobId、非決定要素検出)
4. **KF-04**: 耐久`EXECUTION_STARTED`(最初のSQL文直前にJOBログへrevision付き永続化、確認後にSQL開始。orchestrator経由の`--lock local-only`禁止)
5. **KF-05**: signal/graceful cancel契約(Windows/Unix)と既存`run`/`run-all`/`dry-run`回帰試験
6. **KF-06**: Job lock recovery/force-unlock契約(D-26: 所有はkSQL-Flow、停止確認必須、結果を機械可読で返す。FlowNetはlockレコードを直接変更しない)

## FlowNet側の実機スパイクで確定済みの前提(2026-08-29実測、devenxyfi環境)

- **重複禁止フィールドの上限は64文字**(CB_VA01)。現行`job_key`運用と整合
- **必須+重複禁止フィールドは空文字クリア不可**。現行`finishRecord()`の「job_keyクリア+job_key_done退避」方式は`job_key`が非必須である前提で成立している(維持されたい)
- **ドロップダウンフィールドはクエリで`=`不可**(`in`のみ、GAIA_IQ03)
- **J1 canonical lock key**はFlowNet側で実装・test vector凍結済み: `C:\Users\rex02\Projects\ksql-flownet\src\domain\canonical-lock-key.ts`、`tests\fixtures\canonical-lock-key\vectors.json`(N1/J1、NFC、SHA-256、base64url無padding、46文字)。**ただしJ1への移行はD-14(移行方式)未決のため、Phase 0では現行`{profile}:{job_id}`形式を維持**(current-ksql-flow-changes.md §5どおり)。J1採用時は同vectorとの完全一致が受入条件
- 本番運用でのレコード削除権限は不要な設計を維持(解放=更新方式)

## 受入条件

- current-ksql-flow-changes.md §9のPhase 0受入基準14項目をすべて満たす
- Execution Contract v1 §12のcontract test(正常系/controlled failure/不正結果/signal/互換性)
- 既存利用者への互換性: Exit Code維持(0/1/2/3/4/5、再割当てなし)、`--json`はdry-run専用のまま、FlowNet未導入でも従来どおり動作
- 契約§13の未決事項(result-json上書き規則、executionId発行時点、canonical JSON正規化等)は実装時に決定し、決定内容を返信文書へ記録

## 検証環境

my-ksql-jobsと同一(devenxyfi.cybozu.com、実行ログapp 4249)。トークンはmy-ksql-jobsの.env/OS環境変数の既存変数名を使用し、値を文書・コードへ転記しない。

## 完了時

返信文書(本docs/へ「kSQL-FlowからkSQL-FlowNetへの返信-YYYYMMDD-M1完了報告.md」等)で、実装内容、契約§13の決定事項、受入基準の充足状況、Spike E測定結果を報告されたい。FlowNet側でContract v1のACCEPTED昇格とFDR D-22/D-23/D-26のクローズ審議を行う。
