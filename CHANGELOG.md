# Changelog

このプロジェクトの主な変更を記録します。

## [0.5.0] - Unreleased

- `job_key` の入力ガードを追加。ジョブ名 `__batch__`、プロファイル名／ジョブ名に `:` を含む設定、完成した `{profile}:{name}` が 65 UTF-16 コード単位以上になる設定は、`validate` / `run` / `run-all` で API 呼び出し前に Exit 1 となります。
- **v0.4 からの移行:** v0.4 まで動作していた `:` 入り・65 文字以上・`__batch__` というジョブ名は v0.5 では実行できません。ジョブファイルの `@ksql name` で、`:` を含まない 64 文字以内のキーになる別名へ変更してください（プロファイル名に `:` がある場合は `ksql.config.json` 側も変更してください）。

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

[0.4.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.4.0
[0.3.1]: https://github.com/rex0220/ksql-flow/releases/tag/v0.3.1
[0.3.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.3.0
[0.2.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.2.0
[0.1.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.1.0
