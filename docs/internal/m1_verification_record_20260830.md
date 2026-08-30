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

## 未実施（残項目）

| # | 項目 | 実施方法（予定） |
| --- | --- | --- |
| 2 | `validate --check-logapp` が新フィールドを認識 | Claude Code が検証環境で実行（読取のみ） |
| 3 | 128 文字相関 ID の実機受理 | orchestrator E2E に含めて確認 |
| 4 | orchestrator E2E（`run --result-json` の SUCCESS/NO_DATA・EXECUTION_STARTED レコード・ロック競合・一覧表示） | Claude Code が検証環境で実行（M1-h 机上パートのコミット後） |
| 5 | Windows 実コンソールの Ctrl+C / CTRL_BREAK | オーナー操作（手順は別途提示） |
| 6 | Unix signal 実測 | WSL distro なし・Docker daemon 停止のため環境準備待ち（`linux_docker_verification_plan.md` の枠組み） |
