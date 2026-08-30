# M1 実機検証記録（Execution Contract v1 / Phase 0）

- 環境: devenxyfi.cybozu.com（my-ksql-jobs と同一の検証環境。依頼文書「検証環境」の指定どおり）
- 記録: Claude Code（結果はオーナー実施分を含む）
- 関連: `docs/internal/flow_m1_execution_contract_task.md` §10・M1-h、完了報告ドラフト

## 項目 1: ログアプリ template v0.4 の既存アプリ適用 — **合格（2026-08-30）**

- 実施: オーナー（Takashi）。`scripts/logapp_v04_upgrade.console.js` をブラウザ Console から実行（コミット `04eb725` 版）
- 結果（スクリプト自動検証の出力より）:
  - 相関 5 フィールド追加 OK: correlation_id（相関ID）/ attempt_id（試行ID）/ execution_id（実行ID）/ job_id（論理ジョブ名）いずれも SINGLE_LINE_TEXT、runner_execution_started_at（SQL実行開始日時）DATETIME — 型・非必須・重複禁止なしを本番フォームで確認
  - status ドロップダウンへ CANCELLED 追加 OK（既存選択肢・既定値は不変更）
  - 一覧「FlowNet相関確認」作成 OK（11 列。correlation_id != "" 絞り込み・started_at desc）
  - 総合判定: 「完了: v0.4 更新はすべて正常です。」
- 受入基準対応: 変更点一覧 §9「JOB ログアプリの相関フィールド追加が旧 schema・既存レコードと共存し、rollback できる」のうち、**既存アプリへの追加適用と共存**を実機確認。rollback はスクリプト冒頭の手順（フィールド・選択肢・一覧の削除）で可能なことを設計上確認（実削除の試行は未実施）

## 項目 2: `validate --check-logapp` — **合格（2026-08-30）**

- 実施: Claude Code（読取のみ）。M1-h コミット `46c3c84` のビルドで `--config` に my-ksql-jobs の設定、profile `prod` を使用
- 結果: `OK: ログアプリ (ID 4249) は 8.2 のフィールド定義を満たしています` / Exit 0 — v0.4 の相関 5 フィールドを CLI 側からも認識

## 項目 3: 128 文字相関 ID の実機受理 — **合格（2026-08-30）**

- 128 文字の `--correlation-id` で orchestrator run を実行。結果 JSON への完全 echo と、JOB レコード `correlation_id` に **128 文字の保存・再 GET** を確認（非必須 SINGLE_LINE_TEXT で受理）

## 項目 4: orchestrator E2E（実 kintone） — **合格（1 件の実装修正を検出）**

- 実施: Claude Code。devenxyfi / app 4249、ジョブ `intake_count`（読取のみ・NO_DATA 終了）
- 合格ケース:
  - `run --result-json <path>`: Exit 0、結果 JSON は SUCCESS/NO_DATA・executionStarted=true・correlationId/attemptId echo・asOf 入力文字列そのまま・executionId=UUID。stdout 0 バイト（純度維持）
  - JOB レコード: `correlation_id`(128 字)/`attempt_id`/`execution_id`/`job_id`/`runner_execution_started_at` すべて記録・`job_key_done` 退避を実 GET で確認
  - `--expected-job-id` 不一致: VALIDATION_ERROR / Exit 1 / executionStarted=false / jobId=expected 値
  - 既存 result path: 起動時拒否（Exit 1・stdout 0 バイト・既存ファイル内容不変）
  - `inspect-lock`（RUNNING なし）: `locked:false` / Exit 0
  - `force-unlock-job`: NOT_FOUND / Exit 0、必須入力欠落は API 前拒否
  - `capabilities` / `describe-profile`（canonical・秘密不在を実出力確認）/ `inspect-job`: 期待どおり
- **検出した要修正点（M1-h 追補へ差し戻し）**: kintone DATETIME は**分精度**（秒を保持しない）。`runner_execution_started_at` の実機保存値は `HH:mm:00Z` になるため、M1-d の応答消失時「再 GET で自書込値と完全一致なら続行」は実機では**秒付き値と一致せず常に fail-closed** になる（安全側だが、契約 §13 に記録した回復手順が機能しない）。モックが秒精度で保存していたため机上試験では検出できなかった。対応: 照合を分精度で行う・モックの DATETIME 保存を実機同様に分精度へ・完了報告の「三点一致」を「分精度で一致」へ訂正 — **M1-h 追補で修正済み**（レビュー通過）。あわせてオーナー指摘により、相関 5 フィールドの人為改変防止として `scripts/logapp_v04_field_acl.console.js`（Everyone=閲覧のみ・ランナーの API トークン書込は対象外）を追加

## 項目 4 追記: 相関フィールドのアクセス権 — **適用・追認済み（2026-08-30）**

- オーナーが `scripts/logapp_v04_field_acl.console.js` を実機実行し、相関 5 フィールドすべて Everyone=閲覧のみ を確認（スクリプト自動検証 OK）
- 適用後に Claude Code が orchestrator run を再実行し、**API トークン経由の書込が妨げられない**こと（correlation_id / runner_execution_started_at / status の記録、Exit 0）を実 GET で追認
- 根拠: 監査・耐久証跡の人為改変防止（Q12 と同方式。API トークンは Administrator 相当でフィールドアクセス権の対象外）

## 項目 5: Windows 実コンソール signal — **合格（2026-08-30）**

- 実施: オーナーが PowerShell 実コンソールから standalone `run` を起動し、実行中に **Ctrl+C**
- CLI 出力: `=> CANCELLED (exit 3) 読取 0 件 / 書込 0 件 / API 3 回`・`エラー内容: SIGINT を受信したため実行をキャンセルしました` — graceful cancel が実 OS の signal 配送で機能
- 実ログアプリ追認（Claude Code・実 GET）: `status=CANCELLED`（v0.4 追加選択肢が本番で機能）・`job_key=""` クリア + `job_key_done=prod:intake_count` 退避（ロック解放）・error_message 記録 — 「結果とログ確定 → ロック解放」の実機動作を確認
- Ctrl+Break（SIGBREAK）の実コンソール操作は任意の残項目（`process.emit` による捕捉試験は M1-f で完了済み）

## 項目 6: Unix signal 実測 — **合格（2026-08-30）**

- 環境: VPS vm-69245b5e-30（Linux 6.8.0-138-generic / Node v22.23.2）。新ビルドを npm pack → `/tmp/m1-signal` の隔離ディレクトリへ install（本番 `/opt/ksql/my-ksql-jobs` の node_modules は不変更）。config/.env は運用中のものを使用、ジョブは読取のみの `intake_count`。試験後に一時ファイルは全削除
- 結果:
  - **SIGINT**（実行中 kill）: `CANCELLED (exit 3)`・エラー内容に SIGINT 明記
  - **SIGTERM**（実行中 kill）: `CANCELLED (exit 3)`・SIGTERM 明記
  - **2 回目 signal**（INT×2）: 即時終了 exit 3、結果・終了メッセージ未出力（forced termination 契約どおり）
  - **orchestrator + SIGTERM**: 結果 JSON `status=CANCELLED / resultCode=CANCELLED / exitCode=3`（プロセス Exit と一致）・`executionStarted=false / startedAt=null / count 0`（**SQL 開始前 cancel** の契約ケース）・error.category/code=CANCELLED
- 限定: 実 OS signal で観測した cancel は SQL 開始前フェーズ（ジョブが約 1.5 秒で完走するため）。文間・write chunk 間の境界停止は M1-f の signal 模擬試験で担保済み

## 未実施（任意のみ）

Ctrl+Break 実コンソール・rollback 実削除・ロック競合実機再現（FlowNet D-11 実測と単体試験で担保済み）。**必須の実機検証はすべて完了**。
| - | rollback 実削除の試行（任意）・ロック競合の実機再現（FlowNet D-11 実測と単体試験で担保済みのため任意） | 必要なら追加実施 |

## 追記(2026-08-30): FlowNet M5 実機 E2E による相互確認の完了

FlowNet の M5(直列実行)実機 E2E が全シナリオ合格(ksql-flownet main `ee4acb4` に証跡 8 件)。kSQL-Flow 側に関わる確認:

- 実 kSQL-Flow v0.7.0 subprocess 経由で公式通し 6/6(直列成功/中央 ASSERT 失敗→BLOCKED/resume/分散ロック競合/kill→UNKNOWN/清掃)
- **受入基準 10 の相互確認完了**: 別 cwd 起動による分散ロック裁定で、単体 run 側 LOCK_CONFLICT/Exit 5・network 側 PREPARE_FAILED→WAITING・独立ノード継続・単体側完走を実機確認(当方注意点 3 の反映)
- 再ビルド exe 単体経路(KSQL_FLOW_BIN=ksql-flow.exe)でも serial-success 合格 — dist-bin v0.7.0 再ビルドの検証完了
- kill 試験後の RUNNING 残留なし(全シナリオ自己清掃・force-unlock-job の出番なし)
- 4249 試験レコード(保持中)の識別: ジョブ名 `m5_shared_read` / `m5_midfail_*` / `m5_diamond_*` / `m5_success_*`、correlation_id `netrun_*`、attempt_id `attempt_*`
- 副次効果: 当方発見の DATETIME 分精度を FlowNet ハーネスも踏み(同一分内の started_at 順序依存)、FlowNet 側で修正
