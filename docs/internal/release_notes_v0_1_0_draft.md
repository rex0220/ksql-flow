# v0.1.0 リリースノート案（GitHub Release 用ドラフト）

タグ: `v0.1.0` ／ 対象コミット: main 先頭 ／ 発行: Takashi さん（または `gh release create` で代行）

---

## kSQL Flow v0.1.0 — 初回リリース

kintone のための As Code / DataOps バッチランナーです。SQL スクリプト 1 本で、kintone のアプリ間集計・定期データ更新パイプラインを定義・実行します。

> **as-is / no support**: 本ソフトウェアは MIT ライセンスに基づき現状有姿で提供されます。サポート・動作保証・修正やリリース継続の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、利用者自身の責任で行ってください。

### 主な機能

- **Pure SQL ジョブ**（kSQL Flow dialect 1）: `-- @ksql` ヘッダ・`ASSERT`（業務異常の安全停止）・`EXIT SUCCESS IF`（対象 0 件の正常スキップ）・TEMP TABLE 多段集計・`UPSERT KEY()` / `MERGE`・`@` 付き時刻関数（as-of 固定・バックフィル対応）
- **dry-run 差分プレビュー**: 書込ゼロで INSERT / UPDATE / DELETE 件数と before → after サンプルを表示。`--json` で CI / PR コメント連携
- **運用装備**: kintone ログアプリへの実行記録（BATCH/JOB 親子・同梱テンプレートで即作成）・`job_key` による分散ロック（多重起動 Exit 5）・冪等リラン `--resume`（元 as-of 引き継ぎ）・指数バックオフ + Retry-After リトライ・API 消費の単一カウンタ上限・Webhook 通知 / heartbeat
- **BYOC / セキュリティ**: 通信先は設定した kintone と Webhook のみ。テレメトリなし。認証情報は `env:` 参照でログに出さない
- **fail-closed 設計**: 未知の CLI フラグ・config キーは実行前に Exit 1。ログアプリ到達不能時は書き込まずに停止

### インストール

```bash
npm i -g @rex0220/ksql-flow
```

導入手順・クイックスタートは [README](https://github.com/rex0220/ksql-flow#readme)、仕様の詳細は [公開仕様書](https://github.com/rex0220/ksql-flow/blob/main/docs/ksql_flow_spec.md) を参照してください。

### 互換性

| ksql-flow | エンジン @rex0220/kintone-sql-tools | SQL 方言 |
| --- | --- | --- |
| 0.1.0 | ^3.71.0 | dialect 1 |

Node.js 18 以上。1 スクリプトの文数上限は 20 文。

### 既知の制限

- `run-all --dry-run` は**ジョブ間のデータ依存を再現しません**（前段ジョブの書き込みを行わないため、後段のプレビューは現状データに基づきます）
- `last_written_key` は「最後に成功した書込チャンクの最終キー値（順序保証なし）」という**診断情報**です。復旧位置としては使わず、復旧は冪等リラン（`--resume`）で行います
- クライアント証明書・proxy 設定、validate 時の API 消費見積り、並列実行（`--parallel`）は v0.1 では未対応です
- kintone にトランザクションはなく、書込の原子性は 100 レコード/リクエスト単位です（部分適用があり得る前提の設計です — 仕様書 §5.1）

### 品質・検証

- テスト 146 件（エンジン実体 + インメモリ kintone による結合テスト）+ 実 kintone ドメインでの通し実機検証（正常系・異常系・二重起動・resume・250 件チャンク・タスクスケジューラ起動）
- 開発過程（レビュー往復・裁定ログ・実機検証記録）は [docs/internal](https://github.com/rex0220/ksql-flow/tree/main/docs/internal) で公開しています

---

（2-4 完了後に追記）**Assets**: Windows 単一実行バイナリ `ksql-flow-v0.1.0-win-x64.zip` + `SHA256SUMS.txt`
