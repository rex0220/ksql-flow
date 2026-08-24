# Changelog

このプロジェクトの主な変更を記録します。

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

[0.3.1]: https://github.com/rex0220/ksql-flow/releases/tag/v0.3.1
[0.3.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.3.0
[0.2.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.2.0
[0.1.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.1.0
