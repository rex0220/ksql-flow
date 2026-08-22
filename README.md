# kSQL Flow

kintone のための As Code / DataOps エンジン（CLI 実行ランナー）。SQL スクリプト 1 本で、kintone のアプリ間集計・定期データ更新パイプラインを定義・実行します。

> **Maintenance: as-is / no support**
>
> 本ソフトウェアは MIT ライセンスに基づき **現状有姿（as-is）** で提供されます。
> **サポート・動作保証・質問への回答・不具合修正・継続的なリリースは、いかなる形でも約束されません。**
> Issue / Pull Request は読まれない場合があります。本番環境での利用は、必ず `--dry-run` と
> ステージング環境での検証を経た上で、**利用者自身の責任**で行ってください。
> 商用サポートや SLA が必要な場合は、SIer 等の第三者による有償運用サービスの利用を検討してください
> （MIT ライセンスの下、そのような再配布・商用利用を歓迎します）。
>
> This software is provided **"AS IS"** under the MIT License, **without warranty or support of any
> kind**. There is no commitment to answer questions, fix bugs, or continue releases. Issues and
> pull requests may go unanswered. Use in production at your own risk, after validating with
> `--dry-run` in a staging environment.

## 概要

* SQL（[kSQL Flow dialect 1](../kintone-sql-tools/docs/ksql_language_reference.md)）でジョブを書き、`ksql-flow` が実行・排他・リラン・ログ記録・リトライ・通知を面倒みます。
* SQL の解析・検証・実行はすべて [kintone-sql-tools](https://github.com/rex0220/kintone-sql-tools)（kSQL エンジン）の公式 API `@rex0220/kintone-sql-tools/flow` 経由。本リポジトリに SQL 実装はありません。
* **BYOC**: 実行基盤・認証情報はすべて利用者環境内で完結。通信先は (1) 設定した kintone、(2) 設定した通知 Webhook のみ。テレメトリ・ライセンス照会は一切ありません。

## インストール

```bash
npm i -g @rex0220/ksql-flow
# Node.js 18+ が必要
```

リポジトリ開発時の通常インストールはレジストリ版 `@rex0220/kintone-sql-tools@^3.71.0` を使います。隣接するエンジン作業ツリーで結合確認するときだけ、`npm run dev:engine-local` で `file:../kintone-sql-tools` を `node_modules` へ一時適用します（`package.json` / `package-lock.json` はレジストリ参照のままです）。

## クイックスタート

```bash
# 1. 設定ファイルを用意（examples/ksql.config.json をコピーして編集）
cp examples/ksql.config.json ./ksql.config.json

# 2. ログアプリを作成（推奨: 同梱テンプレートから。template/README.md 参照）
#    kintone システム管理 → アプリテンプレート に template/ksql-flow-log-template1.zip を
#    読み込み → テンプレートからアプリ作成 → API トークン発行（閲覧+追加+編集）
ksql-flow validate --check-logapp --profile prod   # フィールド定義（job_key 重複禁止含む）を検査

# 3. ジョブを検証してから実行
ksql-flow validate -f jobs/01_sync.sql --profile prod
ksql-flow run -f jobs/01_sync.sql --profile prod --dry-run
ksql-flow run -f jobs/01_sync.sql --profile prod
```

## コマンド

```
ksql-flow validate -f <file.sql> [--strict] [--check-logapp]   # フル検証（updateKey 制約等スキーマ依存検証を含む）
ksql-flow validate-all <jobsDir> [--strict]                    # 一括検証（CI 用）
ksql-flow run -f <file.sql> [--as-of ISO8601] [--dry-run]      # 単一ジョブ実行
              [--sample 1..50] [--json]
ksql-flow run-all <jobsDir> [--dry-run] [--sample 1..50] [--json]
                [--resume|--from f|--only f]                   # ディレクトリ一括実行（ファイル名順 + depends_on）
                [--stop-on-error | --continue-on-error]
ksql-flow unlock                                               # ハングした前回セッションのロック解除
ksql-flow init-logapp [--name アプリ名]                        # ログアプリの自動作成（要 password 認証。通常は同梱テンプレート推奨 → template/）
```

共通フラグ: `--profile <name>` `--config <path>` `--max-api-calls N` `--lock local-only` `--force-unlock`

* `--as-of`: 実行基準時刻の上書き（過去日付での再集計 = バックフィル）。`@NOW()` / `@TODAY()` / `@MONTH_START()` / `@NEXT_MONTH_START()` に反映されます。**`@` なしの `TODAY()` 等は kintone サーバー評価のため as-of の対象外**です（検証時に KSQL1306 警告）。
* `--resume`: 直近バッチの FAILED / ABORTED / TIMEOUT / 失敗起因の SKIPPED / RUNNING と、JOB レコードがない未着手ジョブのみを、**元の as-of を引き継いで**再実行します。`--from` / `--only` の選抜外として記録された `SKIPPED (filtered)` は再実行しません（ログアプリが正・`.ksql/state.json` はフォールバック）。
* `--dry-run`: read-only 文を実行し、DML は実レコードとの差分プレビューに置き換えます。`--sample N`（既定 5、1〜50）で変更サンプル数、`--json` で機械可読出力を指定できます。
* `--lock local-only`: `logApp` 未設定時は ConfigError（Exit 1）、設定済みログアプリへ到達できない場合は Exit 3 として、既定では何も実行せず停止します。このフラグで「ローカルロックのみで続行」を明示的に許可できます（警告を表示）。

## dry-run（差分プレビュー）

```bash
# 人が確認する表示（before → after、INSERT / UPDATE / DELETE 件数）
ksql-flow run -f jobs/02_monthly_sales_sync.sql --profile stg --dry-run --sample 5

# run-all は依存順に連続評価。前段を書かないためジョブ間データ依存は再現されない旨を冒頭表示
ksql-flow run-all jobs --profile stg --dry-run

# CI / PR コメント用の 1 JSON オブジェクト
ksql-flow run-all jobs --profile stg --dry-run --json > dry-run.json
```

dry-run は SELECT / CREATE TEMP TABLE / ASSERT / EXIT / SET 等を実行し、INSERT / UPDATE / DELETE / UPSERT だけを `previewStatement` へ送ります。ASSERT 違反は `ABORTED`（Exit 2）、EXIT SUCCESS IF 成立は `NO_DATA`（Exit 0）として本実行と同じゲートになります。

kintone の業務レコード、分散ロック、ログアプリ、state は更新しません。HTTP 層も変更系リクエストを下位 fetch 前に遮断します。記録先はコンソールとローカル JSONL だけです。読み取り API は実消費するため `limits.maxApiCalls` が適用され、超過時はその時点までのプレビューを残して Exit 3 で安全停止します。サンプル値は `logging.maskFields` を `***`、`logging.stripLiterals: true` 時はその他を `?` にして出力します。

CI の最小構成:

```bash
ksql-flow validate-all jobs --profile stg --strict
ksql-flow run-all jobs --profile stg --dry-run --json > dry-run.json
```

## Exit Codes（設計書 10.3）

| Code | 意味 | 対応ステータス |
| --- | --- | --- |
| `0` | 正常終了（`NO_DATA` による正常スキップを含む） | `SUCCESS` / `NO_DATA` |
| `1` | 検証エラー（SQL 構文、論理名未定義、updateKey 制約違反、設定不備） | `FAILED` |
| `2` | 業務アサート違反による安全停止 | `ABORTED` |
| `3` | 実行時エラー（API・認証・ネットワーク・タイムアウト・API 上限超過） | `FAILED` / `TIMEOUT` |
| `4` | 部分成功（`--continue-on-error` で一部ジョブが失敗） | 混在 |
| `5` | 多重起動検知によるスキップ | `LOCKED` |

`run-all` の集約: 全成功 → 0 / `--continue-on-error` で成功と失敗の混在 → 4 / それ以外は失敗ジョブの最重大コード（優先順位 3 > 2 > 5 > 1）。

## 設定ファイル（`ksql.config.json`）

[examples/ksql.config.json](examples/ksql.config.json) を参照。要点:

* 秘密情報は `env:VAR_NAME` 形式で環境変数参照にする（平文を書かない）。
* `extends` は接続設定・`limits`・`retry` 等を継承しますが、**`apps` と `logApp` は継承しません**（stg のつもりが prod を更新する事故の構造的防止。各プロファイルで明示定義が必要）。
* `apps.<名前>.tokens` は 1 アプリ複数トークン対応（カンマ結合で送信・上限 9 個）。リクエストごとに対象アプリのトークンのみ送信します。
* `limits.maxApiCalls` は**ログアプリへの書き込み・ロック操作・リトライの各試行を含む** HTTP リクエスト数の単一カウンタで判定します。
* `notifications.onFailure.webhook`: FAILED / ABORTED / TIMEOUT 時に汎用 JSON を POST（`NO_DATA` では通知しません）。`heartbeat` は裁定 Q1 に基づき、`SUCCESS` / `NO_DATA` を含む Exit 0 の完了時に必ず ping します。

## ログアプリと排他制御

* 実行のたびに kintone ログアプリへ BATCH / JOB の親子レコードを記録します（フィールド定義は設計書 8.2。**同梱の [アプリテンプレート](template/README.md) から作成するのが最も簡単**で、レイアウト・一覧も設定済みです）。
* `job_key`（重複禁止フィールド）への RUNNING レコード先行 INSERT が分散ロックです。終了時に `job_key` はクリアされ `job_key_done` へ退避します。ハング時は `ksql-flow unlock`。
* kintone 標準通知は次の 2 条件を設定します: (1) `record_type = BATCH` かつ status が FAILED 系（`FAILED` / `ABORTED` / `TIMEOUT`）、(2) `record_type = JOB` かつ `parent_batch_id` が空、かつ status が FAILED 系。run-all は BATCH で 1 通に集約し、単発 run の失敗は JOB 条件で拾います。
* ログアプリへ書けない障害時もローカル `.ksql/logs/<batch_id>.jsonl` に必ず記録し、次回実行時に自動再送します。
* `logging.stripLiterals: true` でログ上の SQL からリテラル値を除去。認証情報はいかなるログ・エラーにも出力されません。

## 互換表（エンジン × dialect × Flow）

| kintone-sql-tools | dialect 0 | dialect 1 | ksql-flow |
| --- | --- | --- | --- |
| **v3.71.0** | ✅ | ✅（`previewStatement`） | **✅ 0.1.x（dry-run 本実装）** |
| **v3.70.0** | ✅ | ✅ | **✅ 0.1.x** |

ジョブは `-- @ksql dialect: 1` を宣言してください（Flow 構文 = `ASSERT <条件>, 'msg'` / `ASSERT WARN` / `EXIT SUCCESS IF` / `MERGE` / `KEY()` / `@` 付き時刻関数）。1 スクリプトの文数上限は 20 文です。

## 制限事項（現バージョン）

* チェックポイントの `last_written_key` は、最後に成功した書込チャンクの最終キー値です。書込順の保証はなく、復旧ウォーターマークではなく障害調査用の診断情報として扱います。キー値を取得できない操作ではチャンク情報のみを記録します。
* クライアント証明書（`clientCert`）・`proxy` は未対応です。設定されている場合は、安全のため無視せず ConfigError（Exit 1）で停止します。現バージョンを使う場合はこれらの設定を削除してください。
* 並列実行（`--parallel`）は未対応（設計書どおり初期リリースは順次実行）。

## ドキュメント

* [設計書 v2.8](docs/ksql_flow_design_v2_8.md) / [エンジンからの申し送り v3.71.0](docs/internal/kSQLエンジンからの申し送り-20260822-v3710.md) / [開発経過 (docs/internal)](docs/internal/README.md) / [実装前調査報告](docs/internal/flow_runner_survey_20260821.md)
* SQL 方言リファレンス: kintone-sql-tools [言語リファレンス §27](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_language_reference.md)

## License

[MIT](LICENSE)
