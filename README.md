# kSQL Flow

[![CI](https://github.com/rex0220/ksql-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/rex0220/ksql-flow/actions/workflows/ci.yml)

kintone のための As Code / DataOps エンジン（CLI 実行ランナー）。SQL スクリプト 1 本で、kintone のアプリ間集計・定期データ更新パイプラインを定義・実行します。

> **Maintenance: as-is / no support** — 本ソフトウェアは MIT ライセンスに基づき現状有姿で提供され、
> サポート・動作保証・修正やリリース継続の約束は一切ありません。本番投入は必ず `--dry-run` と
> ステージング検証を経て、利用者自身の責任で行ってください（詳細は末尾の[サポートと保証](#サポートと保証)）。
> This software is provided "AS IS" without warranty or support of any kind.

## 概要

* SQL（[kSQL Flow dialect 1](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_language_reference.md)）でジョブを書き、`ksql-flow` が実行・排他・リラン・ログ記録・リトライ・通知を面倒みます。
* SQL の解析・検証・実行はすべて [kintone-sql-tools](https://github.com/rex0220/kintone-sql-tools)（kSQL エンジン）の公式 API `@rex0220/kintone-sql-tools/flow` 経由。本リポジトリに SQL 実装はありません。
* **BYOC**: 実行基盤・認証情報はすべて利用者環境内で完結。通信先は (1) 設定した kintone、(2) 設定した通知 Webhook のみ。テレメトリ・ライセンス照会は一切ありません。

## インストール

**A. npm（通常の利用者向け）** — Node.js 18+ が必要:

```bash
npm i -g @rex0220/ksql-flow
ksql-flow --help
```

**B. GitHub clone（ソースから使う場合）**:

```bash
git clone https://github.com/rex0220/ksql-flow.git
cd ksql-flow
npm ci && npm run build
node dist/cli.js --help        # または npm i -g . で ksql-flow として導入
```

## クイックスタート

### 0. 用意するもの

| 対象 | 必要な API トークン権限 |
| --- | --- |
| 集計・更新対象の業務アプリ | レコード閲覧 + 編集（INSERT するジョブは追加も）。**lookup フィールドへ書き込む場合は参照元アプリの閲覧トークンも必要**（同じアプリ定義の `tokens` に並べる） |
| 実行ログアプリ（手順 1 で作成） | レコード閲覧 + 追加 + 編集 |

### 1. 実行ログアプリを作成

同梱のアプリテンプレートから作成します（レイアウト・一覧設定済み。手順詳細: [template/README.md](template/README.md)）:

1. テンプレート zip を入手 — GitHub から直接: <https://github.com/rex0220/ksql-flow/raw/main/template/ksql-flow-log-template1.zip>
   （npm でインストール済みなら手元にもあります: `"$(npm root -g)/@rex0220/ksql-flow/template/ksql-flow-log-template1.zip"`）
2. kintone のアプリ作成画面で「テンプレートファイルを読み込む」を選び、zip を直接指定して作成（システム管理への登録は不要）
3. 作成したアプリで API トークン（閲覧 + 追加 + 編集）を発行

### 2. 設定ファイルを保存

作業ディレクトリに `ksql.config.json` を保存し、**`id` を自環境のアプリ ID に置き換えます**（トークン値はファイルへ書かず、環境変数を参照します。完全版の例: [examples/ksql.config.example.json](examples/ksql.config.example.json)）:

```json
{
  "defaultProfile": "prod",
  "profiles": {
    "prod": {
      "baseUrl": "https://example.cybozu.com",
      "timezone": "Asia/Tokyo",
      "auth": { "type": "apiToken" },
      "apps": {
        "顧客マスタ": { "id": 200, "tokens": ["env:KSQL_TOKEN_CUSTOMERS"] },
        "実行ログ": { "id": 999, "tokens": ["env:KSQL_TOKEN_LOGS"] }
      },
      "logApp": "実行ログ"
    }
  }
}
```

### 3. トークンを環境変数に設定

```bash
# bash / zsh
export KSQL_TOKEN_CUSTOMERS="<業務アプリのトークン>"
export KSQL_TOKEN_LOGS="<ログアプリのトークン>"
```

```powershell
# PowerShell
$env:KSQL_TOKEN_CUSTOMERS = "<業務アプリのトークン>"
$env:KSQL_TOKEN_LOGS = "<ログアプリのトークン>"
```

未設定・未解決の `env:` 参照は実行前に ConfigError（Exit 1）で止まります。

### 4. 検証 → dry-run → 実行

`jobs/01_sync.sql` を保存します（`顧客マスタ` の論理名と `処理済み` フィールドは**自環境のアプリ構成に合わせて置き換えてください**）:

```sql
-- @ksql name: sync_customers
-- @ksql dialect: 1
UPDATE LAPP_顧客マスタ SET 処理済み = '済' WHERE 処理済み != '済';
```

```bash
ksql-flow validate --check-logapp --profile prod    # ログアプリの定義検査（field/type/unique/選択肢）
ksql-flow validate -f jobs/01_sync.sql --profile prod
ksql-flow run -f jobs/01_sync.sql --profile prod --dry-run   # 書込ゼロで差分プレビュー
ksql-flow run -f jobs/01_sync.sql --profile prod
```

## コマンド

```
ksql-flow validate -f <file.sql> [--strict]        # ジョブのフル検証（updateKey 制約等スキーマ依存検証を含む）
ksql-flow validate --check-logapp                  # ログアプリの定義検査（-f とは別用途）
ksql-flow validate-all <jobsDir> [--strict]        # 一括検証（CI 用）
ksql-flow run -f <file.sql> [--as-of ISO8601]      # 単一ジョブ実行
              [--dry-run [--sample 1..50] [--json]]
ksql-flow run-all <jobsDir>                        # ディレクトリ一括実行（ファイル名順 + depends_on）
                [--dry-run [--sample 1..50] [--json]]
                [--resume | --from f | --only f]
                [--stop-on-error | --continue-on-error]
ksql-flow unlock                                   # 同一 profile の全 RUNNING を一覧表示後に解除
ksql-flow init-logapp [--name アプリ名]            # ログアプリの自動作成（要 password 認証。通常はテンプレート推奨）
```

全コマンド共通フラグ: `--profile <name>` `--config <path>`。`--max-api-calls N` / `--lock local-only` / `--force-unlock` は run / run-all 専用です。

* `--as-of`: 実行基準時刻の上書き（過去日付での再集計 = バックフィル）。`@NOW()` / `@TODAY()` / `@MONTH_START()` / `@NEXT_MONTH_START()` に反映されます。**`@` なしの `TODAY()` 等は kintone サーバー評価のため as-of の対象外**です（検証時に KSQL1306 警告）。
* `--resume`: 直近バッチの FAILED / ABORTED / TIMEOUT / 失敗起因の SKIPPED / RUNNING と、JOB レコードがない未着手ジョブのみを、**元の as-of を引き継いで**再実行します。`--from` / `--only` の選抜外として記録された `SKIPPED (filtered)` は再実行しません（ログアプリが正・`.ksql/state-<profile>.json` はフォールバック）。
* `--dry-run`: read-only 文を実行し、DML は実レコードとの差分プレビューに置き換えます（書込ゼロ）。ASSERT 違反は `ABORTED`（Exit 2）、EXIT SUCCESS IF 成立は `NO_DATA`（Exit 0）として本実行と同じゲートになります。読み取り API は実消費するため `limits.maxApiCalls` が適用されます。`--sample N`（既定 5、1〜50）と `--json`（CI / PR コメント用の単一 JSON）を併用できます。
* `--lock local-only`: `logApp` 未設定時は ConfigError（Exit 1）、設定済みログアプリへ到達できない場合は Exit 3 として、既定では何も実行せず停止します。このフラグで「ローカルロックのみで続行」を明示的に許可できます（警告を表示）。
* `unlock` / `--force-unlock`: 解除対象は **同一プロファイルの全 RUNNING レコード**です。解除前に jobKey・開始時刻・件数を表示します。有効な別ジョブも対象になり得るため必ず一覧を確認してください。batchId / jobKey 指定解除は v0.1 では未対応です。
* CLI はコマンド別 allowlist で未知・不適用 flag、余分な positional、競合 flag を API 呼び出し前に Exit 1 で拒否します。`--resume` / `--from` / `--only` は相互排他、`--json` / `--sample` は `--dry-run` 専用です。

CI の最小構成:

```bash
ksql-flow validate-all jobs --profile stg --strict
ksql-flow run-all jobs --profile stg --dry-run --json > dry-run.json
```

## Exit Codes（[公開仕様書 §10.3](docs/ksql_flow_spec.md)）

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

完全版の例は [examples/ksql.config.example.json](examples/ksql.config.example.json)。要点:

* 秘密情報は `env:VAR_NAME` 形式で環境変数参照にする（平文を書かない）。
* `extends` は接続設定・`limits`・`retry` 等を継承しますが、**`apps` と `logApp` は継承しません**（stg のつもりが prod を更新する事故の構造的防止。各プロファイルで明示定義が必要）。
* `apps.<名前>.tokens` は 1 アプリ複数トークン対応（カンマ結合で送信・上限 9 個）。リクエストごとに対象アプリのトークンのみ送信します。lookup 書込時は参照元アプリの閲覧トークンも同じ `tokens` に含めます。
* `limits.maxApiCalls` は**ログアプリへの書き込み・ロック操作・リトライの各試行を含む** HTTP リクエスト数の単一カウンタで判定します。
* `notifications.onFailure.webhook`: FAILED / ABORTED / TIMEOUT 時に汎用 JSON を POST（`NO_DATA` では通知しません）。`notifications.heartbeat.on` は `success`（既定。`SUCCESS` / `NO_DATA` の Exit 0 完了時）または `always`（失敗を含む毎実行の完了時）を指定します。
* config の公開契約の正は [JSON Schema](schema/ksql.config.schema.json) です。未知キーは全階層で ConfigError（Exit 1）になります。

## Public contracts in v0.1

| 契約面 | v0.1 の公開契約 | 内部扱い・互換保証外 |
| --- | --- | --- |
| config | `schema/ksql.config.schema.json` のキー・型・未知キー拒否、extends / env / null semantics、`notifications.heartbeat.on` の値域 `success \| always`（既定 `success`） | 解決後の `ResolvedProfile` オブジェクト、validator 実装 |
| CLI / Exit | command、command 別 flag allowlist、排他・dry-run 専用制約、Exit 0〜5 | parser 実装、人間向け文言・装飾 |
| ログアプリ | [公開仕様書 §8.2](docs/ksql_flow_spec.md) の 22 field code/type、`record_type` 2 値、`status` 7 値、`job_key` unique、JOB/BATCH 関係。`log_detail` の **`SKIPPED (` 前方一致**と理由 `filtered` / `LOCKED` の意味 | label・layout・view、prefix 後方の人間向け文言。上記以外の理由文字列（`dependency: x` / `stop-on-error` / `batch-timeout` 等）は情報提供であり追加され得る |
| `--json` | dry-run の `DRY_RUN` / `DRY_RUN_BATCH` exact shape と top-level `formatVersion: 1`。field 追加は additive、破壊変更は version 繰上げ | 通常 run の JSON（v0.1 では `--json` 自体を拒否） |
| JSONL | 全行の `{ v: 1, ts, event, batchId, profile }` envelope、安定 event `write_chunk` / `statement` / `job_start` / `job_finish` / `batch_start` / `batch_finish` / `dry_run_*` | その他の内部 event と payload（best-effort）、安定 event payload への additive field |
| state | `.ksql/state-<profile>.json`、`schemaVersion: 1`、破損・未知 version の警告 fallback | jobs の内部 cache shape、手動編集 |
| template | `template/ksql-flow-log-template1.zip`、22 field / unique / 選択肢のログアプリ契約 | layout・view・label の UX |

`DRY_RUN` の top-level field は `formatVersion, kind, job, profile, asOf, status, exitCode, sampleLimit, reads, writes, actualApiCalls, samples, gate?, incomplete, error?`、`DRY_RUN_BATCH` は `formatVersion, kind, warning, exitCode, jobs` です。完全な nested shape と変更規則は [公開仕様書 §10.2](docs/ksql_flow_spec.md) を参照してください。

## ログアプリと排他制御

* 実行のたびに kintone ログアプリへ BATCH / JOB の親子レコードを記録します（フィールド定義は [公開仕様書 §8.2](docs/ksql_flow_spec.md)。**同梱の [アプリテンプレート](template/README.md) から作成するのが最も簡単**で、レイアウト・一覧も設定済みです）。
* `job_key`（重複禁止フィールド）への RUNNING レコード先行 INSERT が分散ロックです。終了時に `job_key` はクリアされ `job_key_done` へ退避します。ハング時は `ksql-flow unlock`（同一 profile の全 RUNNING が対象で、解除前に一覧表示）。
* kintone 標準通知は次の 2 条件を設定します: (1) `record_type = BATCH` かつ status が FAILED 系（`FAILED` / `ABORTED` / `TIMEOUT`）、(2) `record_type = JOB` かつ `parent_batch_id` が空、かつ status が FAILED 系。run-all は BATCH で 1 通に集約し、単発 run の失敗は JOB 条件で拾います。
* ログアプリへ書けない障害時は、ローカル `.ksql/logs/<batch_id>.jsonl` と再送キューへの保存を可能な限り行います。保存失敗時は stderr へ警告し、実行は継続します。
* `logging.stripLiterals: true` でログ上の SQL からリテラル値を除去。認証情報はいかなるログ・エラーにも出力されません。

## 互換表（Flow × エンジン × dialect）

| ksql-flow | @rex0220/kintone-sql-tools | dialect |
| --- | --- | --- |
| **0.1.0** | **^3.71.0** | **1** |

ジョブは `-- @ksql dialect: 1` を宣言してください（Flow 構文 = `ASSERT <条件>, 'msg'` / `ASSERT WARN` / `EXIT SUCCESS IF` / `MERGE` / `KEY()` / `@` 付き時刻関数）。1 スクリプトの文数上限は 20 文です。

## 制限事項（現バージョン）

* チェックポイントの `last_written_key` は、最後に成功した書込チャンクの最終キー値です。書込順の保証はなく、復旧ウォーターマークではなく障害調査用の診断情報として扱います。キー値を取得できない操作ではチャンク情報のみを記録します。
* クライアント証明書（`clientCert`）・`proxy` は未対応です。設定されている場合は、安全のため無視せず ConfigError（Exit 1）で停止します。現バージョンを使う場合はこれらの設定を削除してください。
* validate の推定 API 消費・推定所要時間表示は v0.1 では未対応です。推定と実測読み取り API 消費は `--dry-run` の EXPLAIN / preview で確認してください。
* 並列実行（`--parallel`）は未対応（初期リリースは順次実行）。

## Windows タスクスケジューラ / PowerShell 5.1

[examples/windows-task-scheduler/run_batch.bat](examples/windows-task-scheduler/run_batch.bat) を利用できます。`.ps1` に置き換えて Windows PowerShell 5.1 (`powershell.exe`) から実行する場合、日本語を含むスクリプトは **UTF-8 with BOM** で保存してください。BOM なし UTF-8 は PowerShell 5.1 で ANSI と解釈され、文字化けやパースエラーになることがあります。PowerShell 7 (`pwsh`) は BOM なし UTF-8 を標準で扱います。

実行環境別のセットアップ例（GitHub Actions / タスクスケジューラ / cron / Docker）は [examples/](https://github.com/rex0220/ksql-flow/tree/main/examples) を参照してください（npm パッケージには含まれません）。

## ドキュメント

* [公開仕様書](docs/ksql_flow_spec.md)（アーキテクチャ・実行モデル・ロック・リラン・ログ設計の正）
* [CHANGELOG](CHANGELOG.md)
* SQL 方言リファレンス: kintone-sql-tools [言語リファレンス §27](https://github.com/rex0220/kintone-sql-tools/blob/main/docs/ksql_language_reference.md)

## サポートと保証

本ソフトウェアは MIT ライセンスに基づき **現状有姿（as-is）** で提供されます。**サポート・動作保証・質問への回答・不具合修正・継続的なリリースは、いかなる形でも約束されません。** Issue / Pull Request は読まれない場合があります。本番環境での利用は、必ず `--dry-run` とステージング環境での検証を経た上で、**利用者自身の責任**で行ってください。商用サポートや SLA が必要な場合は、SIer 等の第三者による有償運用サービスの利用を検討してください（MIT ライセンスの下、そのような再配布・商用利用を歓迎します）。

This software is provided **"AS IS"** under the MIT License, **without warranty or support of any kind**. There is no commitment to answer questions, fix bugs, or continue releases. Issues and pull requests may go unanswered. Use in production at your own risk, after validating with `--dry-run` in a staging environment.

## License

[MIT](LICENSE)
