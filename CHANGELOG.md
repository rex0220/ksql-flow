# Changelog

このプロジェクトの主な変更を記録します。

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

[0.1.0]: https://github.com/rex0220/ksql-flow/releases/tag/v0.1.0
