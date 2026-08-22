# 実行タスク指示書: Phase 0 実機検証（担当: Codex / 検証記録レビュー: Claude Code）

**対象**: `docs/release_checklist_v0_1_0.md` の Phase 0（0-2〜0-4, 0-7）
**検証環境**: Takashi さんが用意済み（0-1 完了）。接続情報は `docs/test-app/api.txt`（**下記 §1 で直ちにリポジトリ外へ退避すること**）
**最終更新**: 2026-08-22

---

## 1. 最優先: 秘密情報の退避（他の全作業に先行）

`docs/test-app/api.txt` には実ドメインと API トークン 4 本が平文で置かれている。これは公開予定リポジトリの作業ツリー内であり、チェックリスト 1-1（秘密スキャン）の一発アウト対象。**コードを 1 行書く前に**次を行う:

1. `api.txt` を**リポジトリ外**（例: `%USERPROFILE%\.ksql-flow-dev\api.txt`）へ移動し、`docs/test-app/` ディレクトリ自体を削除する。
2. `git log --all` / `git status` で **api.txt が一度もコミット・ステージされていないこと**を確認し、結果を検証記録に残す（もし履歴に入っていたら作業を止めて報告 — トークン再発行が必要になる）。
3. トークンは環境変数へ移す: リポジトリ外に `%USERPROFILE%\.ksql-flow-dev\dev.env`（`KSQL_DEV_TOKEN_ACTIVITY` / `_CUSTOMER` / `_DEAL` / `_STAFF` / 後述 `_LOGS`、`KSQL_DEV_BASEURL`）を作り、実行時に読み込む。`.gitignore` に `*.env` / `.ksql/` が入っていることを確認。
4. **以後、リポジトリ内のあらゆるファイル（検証記録・ジョブ SQL・config 例・コミットメッセージ）に実ドメイン名とトークンを書かない**。ドメインは `https://<dev>.cybozu.com` 表記、config は `env:KSQL_DEV_BASEURL` 参照とする。検証記録も同様（Claude Code レビューで機械 grep する）。

## 2. セットアップ

* `ksql.config.json` に `dev` プロファイルを作成: `baseUrl: env 参照`・`timezone: Asia/Tokyo`・`apps`: 活動履歴 4245 / 顧客管理 4246 / 案件管理 4247 / 担当者管理 4248（トークンはすべて `env:` 参照）。
* 検証用ファイル一式は `verification/`（ジョブ SQL・手順）に置き、実値を含まないことを前提に**リポジトリに含めて良い**（公開後は再現手順のドキュメントとして価値がある）。

## 3. 検証項目

### 3-1. ログアプリ生成（チェックリスト 0-2）

1. `ksql-flow init-logapp --profile dev` で実行ログアプリを実生成（可能なら検証スペース配下に作成。作成先の指定可否は実装仕様に従う）。
2. **人間手順の依頼**: 生成したログアプリの API トークン（追加 + 更新 + 閲覧）は kintone UI でしか発行できないため、アプリ ID とともに Takashi さんへ発行を依頼し、`KSQL_DEV_TOKEN_LOGS` に設定してもらう。依頼文（どのアプリ・どの権限か）を報告に含める。
3. `ksql-flow validate --check-logapp --profile dev` 通過（`job_key` の重複禁止設定まで確認されること）。

### 3-2. 実スキーマに合わせた検証ジョブの作成（0-3 の準備）

用意されたアプリは設計書のサンプル（受注 / 顧客マスタ）とは別スキーマ。**先にスキーマを実測してからジョブを書く**:

1. `/flow` の `validateScript(…, { client })` 経由（またはランナーの validate）で 4 アプリのフィールド構成を把握する。
2. 検証ジョブ 2 本を作成（`verification/jobs/`）:
   * `01_sync_masters.sql`: 担当者管理 or 顧客管理を読み、集計先に必要なマスタ整合を確認する軽量ジョブ（ASSERT + SELECT 中心）
   * `02_aggregate_deals.sql`: **案件管理（4247）を顧客単位に集計し、顧客管理（4246）へ UPSERT** する本命ジョブ。設計書 3.1 と同じ構成要素（ヘッダ・ASSERT・TEMP TABLE・EXIT SUCCESS IF・`@` 付き時刻関数・KEY 指定）を全部含めること
3. **UPSERT キーの前提確認**: 顧客管理側のキーフィールド（顧客コード等）に「値の重複を禁止する」設定が必要（3.4）。未設定なら validate が KSQL1301 系で検出するはず — その検出自体も検証結果として記録し、設定変更を Takashi さんへ依頼する。
4. テストデータ投入もジョブで行う（`verification/seed/` に INSERT ジョブ。14 章の「テストも As Code」の実地確認を兼ねる）。

### 3-3. 通し検証（0-3）

`validate` → `--dry-run`（差分プレビューの内容確認・**ミューテーション 0 の実機確認**）→ `run` → ログアプリの BATCH/JOB レコードとメトリクス実値（read_count / written_count / api_calls / last_written_key）の突合。dry-run の予告件数と run の実績件数の一致も確認。

### 3-4. 異常系の実機再現（0-4）

1. ASSERT 違反（マイナス金額データを seed で仕込む）→ `ABORTED` / Exit 2 / 書き込みゼロ
2. 対象 0 件 → `NO_DATA` / Exit 0 / 通知なし
3. 二重起動（2 プロセス同時 `run`）→ 片方 Exit 5・終了後 `job_key` クリア・直後の再実行成功
4. `--resume`: ジョブを途中失敗させ（例: ログアプリトークンを一時的に無効な env にする等、可逆な方法で）、翌実行の `--resume` が失敗ジョブのみ・元 as-of で再実行することをログアプリの `as_of` 実値で確認
5. 100 件超の書込（seed で 250 件以上）→ チャンク分割と `onChunkWritten` チェックポイントの実機動作

### 3-5. 検証記録（0-7）

`docs/release_verification_v0_1_0.md` に、項目ごとに実行コマンド（env 参照表記）・結果・確認方法を記録。§1-4 のマスキング規約を厳守。0-5（Webhook 実受信）と 0-6（Windows タスクスケジューラ）は Takashi さん実施項目のため、**実行手順書（コピペで実行できる粒度）**を同ファイルに用意して依頼する。

## 4. 完了条件と後続

* 0-2〜0-4 の全項目 PASS + 検証記録完成 → Claude Code が記録をレビュー（特に §1 の秘密退避の確認と、記録への実値混入の機械 grep）。
* FAIL や実装不具合が出た場合は通常の差し戻しフロー（修正 → 再検証 → レビュー）。実機でしか出ない不具合はそれ自体が本検証の成果なので、遠慮なく起票すること。
* Phase 0 全通過後、チェックリスト Phase 2（GitHub 公開）へ。
