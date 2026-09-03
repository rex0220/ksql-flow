# Changelog

このプロジェクトの主な変更を記録します。

## [0.8.0] - 2026-09-04

- Execution Contract v1.1: 名前付き IMPORT source(repeatable の `--import-csv` / `--import-json`)と orchestrator 必須の `--expected-import-sha256`(SQL 開始前照合・不一致は INPUT_FILE_MUTATED で mutation 0)を追加。engine v3.76.0 の公開 API(createImportSourceResolver / onImportSourceMaterialized)だけで配線し、Execution Result へ additive な `input_files`(name / sha256 / bytes / rows? / encoding?)を記録します。rows と実効 encoding は engine の materialize receipt 成功時のみ確定し、同一 source を異なる ENCODING で読むと解釈ごとに別 entry になります。
- capability `features.importCsv: true` を公開(engine ^3.76.0)。同名 source 重複・未供給・sha 欠落/余剰/不一致は実行前エラー、未使用供給は警告。ファイルは通常ファイルのみ・10 MiB 上限・絶対パス/セル値は結果 JSON 非含有。仕様 §3.9 に IMPORT 独立節を追加(素の IMPORT は再実行で重複し得るため、重複禁止単一キーの ON DUPLICATE upsert を推奨)。

## [0.7.0] - 2026-08-30

- FlowNet 等の orchestrator から単一 `run` を安全に呼び出す 4 フラグ（`--result-json` / `--correlation-id` / `--attempt-id` / `--expected-job-id`）を追加。Execution Result v1 の正本 JSON Schema を同梱し、stdout 純 JSON、path の atomic 書込・既存ファイル上書き拒否、ID 照合、controlled failure の機械可読結果を契約化しました。
- 互換性・設定・ジョブを通信なしで検査する `capabilities --json` / `describe-profile --json` / `inspect-job --json` を追加。orchestrator 実行では最初の SQL 文直前にログアプリへ耐久 `EXECUTION_STARTED` を revision 付きで記録し、確認不能時は SQL 未開始で fail-closed します。
- 単一 `run` の graceful cancel を追加。1 回目の SIGINT / SIGTERM / SIGBREAK は進行中 request と確定済み chunk を待って `CANCELLED`（Exit 3）を返し、2 回目は即時終了します。signal と真のエラーが同時発生した場合も結果は `CANCELLED` を優先し、元エラーはローカル JSONL に残します。
- 対象限定のロック診断・回復コマンド `inspect-lock --json` / `force-unlock-job --json` を追加。停止確認者・理由・証拠 URI を必須とし、revision 固定の単一 UPDATE と再照会で解除結果を機械可読に返します。既存の人間向け `unlock` / `--force-unlock` は変更しません。
- 同梱ログアプリテンプレートを v0.4 に更新。任意の相関フィールド 5 個と `CANCELLED` 選択肢に加え、orchestrator 実行の確認用一覧「FlowNet相関確認」とレイアウト（相関フィールドを `バッチ実行ID` 直後に配置）を収録しました。旧ログアプリは standalone 実行で引き続き利用でき、orchestrator 実行だけは必要フィールド欠落時に SQL 未開始で拒否します。
- 既存アプリを v0.4 相当へ更新するブラウザ Console スクリプト 2 本を同梱しました（`scripts/logapp_v04_upgrade.console.js` = フィールド・選択肢・レイアウト・一覧の追加、`scripts/logapp_v04_field_acl.console.js` = 相関 5 フィールドの Everyone=閲覧のみ ACL。kintone テンプレートはフィールドアクセス権を持ち出せないため、ACL はテンプレート経路でもこのスクリプトで設定します）。
- `validate --check-logapp` は相関 5 フィールドと status の `CANCELLED` を任意扱いにしました。旧 v0.3 アプリでも NG にならず、情報行で追加手段を案内します（orchestrator 実行時のみ実行時検査で必須）。
- 既存の `run` / `run-all` / dry-run / resume / Exit Code は後方互換です。新しい orchestrator 4 フラグは全て未指定なら従来動作、いずれかを指定した場合だけ 4 つ全てを要求します。Execution Contract v1 は kSQL-FlowNet 側で ACCEPTED（2026-08-30）。

## [0.6.0] - 2026-08-28

- `run-all --resume-batch <batch_id>` を追加。指定 BATCH だけを再開元にし、元の as-of と失敗・未着手ジョブ選抜を引き継ぎます。BATCH の 0 件／複数件、profile 不一致、選抜フラグ併用は Exit 1。ログアプリ取得失敗時は `state.json` へフォールバックせず Exit 3 で fail-closed します。
- 環境変数 `KSQL_HOST_LABEL` を追加。1〜64 文字の `[A-Za-z0-9._:-]` をログアプリの BATCH / JOB `host` に記録し、不正値は API 呼び出し前に Exit 1。ローカルロックの host 記録・同一ホスト生存判定は従来どおり `os.hostname()` を使用します。
- 公開仕様書 §6 / §8.2 / §10.1 と CLI usage を更新し、対象指定再開、state フォールバック禁止、host ラベルの用途と制約を明文化しました。

## [0.5.0] - 2026-08-28

- **`job_key` の入力ガードを追加**（170 tests green）。ジョブ名 `__batch__`、プロファイル名／ジョブ名に `:` を含む設定、完成した `{profile}:{name}` が 65 UTF-16 コード単位以上になる設定は、`validate` / `run` / `run-all` で API 呼び出し前に Exit 1 となります。
- **v0.4 からの移行:** v0.4 まで動作していた `:` 入り・65 文字以上・`__batch__` というジョブ名は v0.5 では実行できません。ジョブファイルの `@ksql name` で、`:` を含まない 64 文字以内のキーになる別名へ変更してください（プロファイル名に `:` がある場合は `ksql.config.json` 側も変更してください）。上限 64 文字と「数え方は UTF-16 コード単位（JavaScript の `.length` と一致）」は 2026-08-28 の kintone 実機測定で確認した値です。
- 同梱アプリテンプレートを更新: **アプリの説明**（レコードの見方・リラン依頼の手順・編集方針・障害対応ランブックへの導線）を収録。説明文中のランブック URL は各自のジョブリポジトリへ差し替えてください（雛形は [ksql-flow-template](https://github.com/rex0220/ksql-flow-template) の `docs/runbook.md` に同梱）。
- 公開仕様書 §5.5 を改訂: 分散ロックを**リース（時限付き占有）**として保証範囲を明文化し、stale 回収検知時の**復旧手順（ランブック）**・自動回収を許容できるジョブ / 危険なジョブの二分類・運用前提（NTP・レコード ACL 不使用・全件閲覧トークン）・**必須監視構成**（`RUNNING` 長時間のリマインダー通知）を追加。

## [0.4.1] - 2026-08-27

- コード変更なし（配布物のみのパッチリリース。160 tests green）。
- 同梱アプリテンプレートを更新: **リラン指示ポーラー用の `rerun_` フィールド 10 個**（`rerun_request` チェックボックス・`rerun_state` ドロップダウンほか）を収録。**ランナーの動作には不要**（`validate --check-logapp` の検査対象外）で、既存アプリのままでも従来どおり動作します。必要になるのは、kintone のチェックボックスから VPS 等のリランを起動する「リラン指示ポーラー」を導入する場合のみです（ポーラー本体は本パッケージには同梱していません — 実運用の実績を経てからの公式化を予定）。
- `template/README.md` を追随: テンプレートに含まれない設定（フィールドのアクセス権・リマインダーの条件通知 — いずれも環境のグループに依存するため kintone のテンプレート書き出し対象外）と、ポーラー導入時の設定指針を明記。

## [0.4.0] - 2026-08-25

- エンジン依存を v3.74.0 系に更新（`^3.74.0`）。素の UPSERT は既定で kintone の **native upsert**（`updateKey` + `upsert: true`）となり、**事前 GET（50 キー/回）が消えて UPSERT の API 消費が約 1/3 に**（例: 1 万件で 300 → 100 回。日次 API リクエスト数にも効く）。適用条件を欠く文（空文字キー・ソース内キー重複・CHECK/APPLY 併用等）は従来経路へ自動フォールバックし、結果は等価。
- **注意: native upsert は更新だけで完結する UPSERT でも対象アプリの「レコード追加権限」を要求**します（kintone の仕様）。標準の書込可トークン（閲覧 + 追加 + 編集）なら影響ありません。
- ランナーのコード変更はなし（`operation` の新値 `"UPSERT"` は既存の集計・記録に影響しないことを確認）。公開仕様 §3.4 / §11 の実装注記と推定式の記述を更新。テストのモック kintone に native upsert セマンティクス（updateKey 照合・ソース内重複 GAIA_IQ28・空文字キー拒否・`records[].operation`）を実装。

## [0.3.1] - 2026-08-24

- コード変更なし（配布物のみのパッチリリース）。
- 同梱アプリテンプレートを更新: レコードのタイトルを「スクリプト名」に設定（kintone 標準の条件通知・通知メールの一覧でジョブ名が読めるように）。
- README に失敗通知の設定レシピを拡充: 2 条件 + 通知文例 + 宛先はジョブ管理グループ推奨。
- 公開仕様書に §4.1「途中のジョブが失敗したときのふるまい（まとめ）」を新設（Codex レビュー済み）。maxApiCalls 超過時の以降停止・個別ロック競合時の SKIPPED (LOCKED) と通知非発火を明文化。

## [0.3.0] - 2026-08-23

- ログアプリに任意の `deleted_count`（削除件数）を追加し、JOB / BATCH ごとの DELETE 件数を記録。`written_count` は削除を含む従来の合算を維持し、表示名を「書込件数」に変更。
- 旧テンプレート製ログアプリでは `deleted_count` を送信せず、情報表示のみで互換動作するようにした。`validate --check-logapp` でも同フィールドは任意として検査。
- ログアプリの `ksql_version` が package.json のバージョンに追随するよう修正（v0.2.0 でも「flow 0.1.0」と記録されていた表示漏れ）。
- 同梱アプリテンプレートを v0.3 版（deleted_count 追加・「書込件数」ラベル）に更新。

## [0.2.0] - 2026-08-23

- `limits.maxReadRows`（1〜200,000）を追加し、通常実行と dry-run の文単位読取候補上限を設定可能化（未指定はエンジン既定 10,000 のまま。エンジン `/flow` の `maxRecords` へ引き渡し）。
- 公開仕様書 11 章の「ストリーミング最適化」を将来検討へ改め、現状の読取上限の扱いを明記。

## [0.1.0] - 2026-08-22

- kSQL Flow dialect 1 のジョブを検証・実行する `ksql-flow` CLI を初回公開。
- 単一ジョブと依存関係付き一括実行、dry-run 差分プレビュー、冪等リランを追加。
- ローカル / kintone ログ、分散ロック、リトライ、API 上限、タイムアウト、Webhook 通知を追加。
- GitHub Actions、Windows タスクスケジューラ、cron、Docker の実行例を追加。
- kintone 実行ログアプリのテンプレートを同梱。
- CLI の未知・不適用 flag、余分な positional、競合 flag と config の未知キーを fail-closed（Exit 1）で拒否。
- dry-run JSON に `formatVersion: 1`、JSONL に `v: 1` / batchId / profile 共通 envelope を追加し、state の profile 別 path と警告 fallback を公開契約化。
- `--check-logapp` の選択肢集合検査、template 契約テスト、Node 18 / npm pack install smoke CI、unlock 対象一覧表示を追加。
- clientCert / proxy と validate の推定 API 消費・所要時間表示を v0.1 非対応として明記。

[0.6.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.6.0
[0.5.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.5.0
[0.4.1]: https://github.com/rex0220/ksql-flow/releases/tag/v0.4.1
[0.8.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.8.0
[0.7.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.7.0
[0.4.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.4.0
[0.3.1]: https://github.com/rex0220/ksql-flow/releases/tag/v0.3.1
[0.3.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.3.0
[0.2.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.2.0
[0.1.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.1.0
