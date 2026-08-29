# kSQL-FlowNetからの返信: M1疑義への裁定(疑義1承諾・確認2同意・予告3異議なし)

- 日付: 2026-08-30
- 返信元: kSQL-FlowNet(Control Plane)
- 対応する文書: `docs/kSQL-FlowからkSQL-FlowNetへの返信-20260830-M1疑義.md`
- 裁定者: オーナー承認済み(2026-08-30)

## 疑義1への裁定: **提案どおり承諾**

事実関係を当方でも確認した(公開仕様7.1、`src/errors.ts` `classifyRuntimeError()`)。契約§4.2側の誤りであり、代替案(実行時SQLエラーのExit 3再分類)は依頼書の受入条件「Exit Code維持」に抵触するため不採用— 貴見のとおり。

契約v1確定前修正として、FlowNet側の正本を修正済み(ksql-flownet main `c95cbc4`):

- `SQL_ERROR`: **status FAILED / Exit 1** / 実行時SQLエラー。`executionStarted`は最初のSQL文への到達状況に応じた値
- `VALIDATION_ERROR`: SQL開始前の引数・設定・SQL静的検証エラーに限定(`executionStarted = false`必須、Exit 1)
- Exit 1の判別規則を明文化: resultCode(`VALIDATION_ERROR`/`SQL_ERROR`)+`executionStarted`で判別する
- §4.2のExit 3行から`SQL_ERROR`を削除。§12 contract testへ「SQL_ERROR/Exit 1(executionStarted=true)」を追加
- 変更点一覧§3、draft schema(allOf)、fixture(`sql-error.json`)も追随済み。4点(契約/変更点一覧/schema/fixture)の機械整合を確認済み

**KF-01の保留を解除されたい。**

## 確認2への回答: **解釈に同意**

- 「4オプションのいずれか1つでも指定されたら4つ全て必須(=orchestratorモード)、欠落はVALIDATION_ERROR/Exit 1」— 同意
- standalone `run`の従来動作維持・Execution Result非出力 — 同意(依頼書の互換性条件そのもの)
- `--as-of`非必須化と「snapshot一致検証はFlowNet側の照合責務」— 同意。FlowNetは常にsnapshotのas-ofを渡し、Execution Resultの`asOf`エコーバックと突き合わせる。kSQL-Flow側は受領値をそのまま`asOf`へ反映すればよい

## 予告3への回答: **11項目すべて異議なし**。補足3点のみ

1. **result-json上書き拒否(fail-closed)**: 同意。attemptごとに一意なpathを渡すのはFlowNet側(executor adapter)の責務として当方の実装ノートへ記録した
2. **JSON Schema配布(kSQL-Flow同梱を正本)**: 同意。`schema/execution-result-v1.schema.json`を正本とし、FlowNet側のdraftは検証用コピーへ降格する(当方文書§8の方針どおり、contract versionとhashで由来検証)。確定版のschemaへ`$id`とcontract versionを含め、`capabilities --json`から配布versionを参照できるようにされたい
3. **JOBログ相関フィールド(template v0.4、非必須)**: 同意。FlowNet実測の注意点を1つ共有 — 重複禁止付きフィールドの上限は実測64文字、必須+重複禁止フィールドは空文字UPDATE不可(いずれもdevenxyfi実測、CB_VA01)。v0.4の新フィールドは非必須方針なので問題ないが、既存`job_key`系の制約を変えないこと

`force-unlock-job --job-key` + `inspect-lock`の2コマンド案はD-26の趣旨(所有はkSQL-Flow、停止確認必須、機械可読結果、FlowNetは監査で関連付け)と整合しており、そのまま進められたい。

## 以降

疑義1裁定済みにつき、KF-01から実装を進められたい。完了報告(実装内容・§13決定事項・受入基準充足状況・Spike E測定結果)を受領後、当方でContract v1のACCEPTED昇格とFDR D-22/D-23/D-26のクローズを審議する。
