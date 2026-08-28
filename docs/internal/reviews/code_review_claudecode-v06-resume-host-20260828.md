# コードレビュー記録: v0.6 --resume-batch / KSQL_HOST_LABEL（2026-08-28）

- 対象: v0.6 実装（Codex・未コミット working tree）。起票 `docs/internal/flow_v06_resume_target_task.md`
- レビュー担当: Claude Code / 判定: **承認（修正指摘なし）**

## 検証結果（レビュー側で独立実行）

- `npm test`: **187/187 green**（17 suites）・`npm run typecheck` green
- `src/lock.ts`: **差分なし**（起票の罠 — ローカルロックの host 記録・同一ホスト生存判定は実ホスト名を維持）
- エンジンリポジトリ `../kintone-sql-tools`: 不可侵を確認（変更ファイル 1 件は 8/25 のエンジン側 B176 作業・本件と無関係）
- バージョン 0.6.0・CHANGELOG・公開仕様書（§4.1 復旧・§6 選抜・§6.3 規則・§8.2 host 列・§10.1 CLI 契約）更新済み

## 受入基準の突合

| 基準 | 判定 | 根拠 |
| --- | --- | --- |
| 指定バッチのみ再開・新しい BATCH の影響なし | ✔ | `resolveResumeBatch` は `findBatchesById(batchId)` のみ参照。テスト「指定した古い BATCH のみを再開…」 |
| 0 件・複数件・profile 不一致・`--resume` 併用 Exit 1 | ✔ | `limit 2` クエリで多重検出・ConfigError(Exit 1)。併用は cli.ts の rejectConflict + runAll 側の二重防御 |
| ログアプリ GET 失敗で state フォールバックせず fail-closed | ✔ | `resolveResumeBatch` は state.json 経路を持たない。GET 失敗 → classifyRuntimeError → Exit 3。テストあり |
| JOB は指定バッチ配下のみ | ✔ | `listBatchJobs(batchId)`。テスト「他 BATCH の失敗を混ぜない」 |
| ラベル: ログ host に反映・ロックは実ホスト名 | ✔ | `resolveLogHost()`（新規 src/host.ts・1〜64 文字 `[A-Za-z0-9._:-]`・不正は API 前に Exit 1）→ `env.logHost` を BATCH/JOB 記録のみに使用。テスト 2 本（上書き範囲・生存判定） |
| 既存 `--resume` 不変更 | ✔ | 選抜ロジックは `selectResumeJobs` へ抽出（意味論同一・RERUN_STATUSES 同一集合）。既存テスト全 green |

## 起票より厳密な良い判断（記録）

- `findBatchesById` の応答 batch_id エコーバック検査・不正 `as_of` を `LogAppResponseError`（Exit 3）で fail-closed — 明示指定対象の解決に「黙って別物」を許さない
- `createRunnerEnv` の失敗（不正ラベル等）を run / run-all 双方で捕捉し、API 呼び出し前に Exit 1

## 備考

- 仕様書内のコマンド例 `ksql run-all` 表記は既存慣例（従来から混在 11 箇所）に従ったもので、本件での新規不整合ではない
