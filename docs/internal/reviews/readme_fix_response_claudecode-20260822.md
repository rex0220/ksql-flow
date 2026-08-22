# README レビュー対処記録（Claude Code / 2026-08-22）

- 対象レビュー: `readme_review_codex-20260822.md`（BLOCKER 2 / MAJOR 7 / MINOR 3・公開不可判定）
- 対処: 全件を文書・構成修正で解消（実装変更なし。B-2 の CLI 側競合拒否はレビュー指示どおり実装変更せず synopsis 分離で対応）

## 指摘別の対処

| 指摘 | 対処 |
| --- | --- |
| A-1 (BLOCKER) Quickstart 自己完結 | 手順 0「用意するもの」（業務/ログアプリのトークン権限表・lookup 参照元の注意）を新設。手順 3 に bash / PowerShell の環境変数設定例。placeholder（アプリ ID・フィールドコード・論理名）の置換指示を各所に明記 |
| A-2 (BLOCKER) npm 利用者の template 取得 | 手順 1 に **GitHub 直接ダウンロード URL** と `$(npm root -g)` によるインストール済みパスの両方を記載 |
| A-3 / D-1 (MAJOR) install 2 経路 | 「A. npm」「B. GitHub clone（`npm ci && npm run build` → `node dist/cli.js` / `npm i -g .`）」に分離。engine-local 開発説明は `docs/internal/README.md` の「開発メモ」へ移設 |
| B-1 (MAJOR) 共通フラグの誤り | 「全コマンド共通 = `--profile` / `--config`。`--max-api-calls` / `--lock` / `--force-unlock` は run / run-all 専用」に修正 |
| B-2 (MAJOR) validate synopsis | `validate -f <file.sql> [--strict]` と `validate --check-logapp` を別行に分離（「別用途」明記） |
| B-3 (MAJOR) 参照先が内部設計版 | 「設計書 v2.9 §10.2」「§8.2」等をすべて **[公開仕様書](../../ksql_flow_spec.md) へのリンク**に統一 |
| B-4 (MAJOR) config 例が未追跡 | **`examples/ksql.config.json` → `examples/ksql.config.example.json` に改名**（`.gitignore` の basename マッチを回避）し git 追跡化。README の参照 2 箇所を更新。`git ls-files` で追跡を確認済み |
| B-5 (MINOR) reserved reason | 公開契約を「`SKIPPED (` 前方一致 + `filtered` / `LOCKED` の意味」に限定し、他の理由文字列（dependency: / stop-on-error / batch-timeout 等）は「情報提供・追加され得る」と明記 |
| C-1 (MAJOR) 内部資料の一次導線 | ドキュメント節を公開仕様書・CHANGELOG・言語リファレンスに限定（申し送り・開発経過・調査報告のリンクを除去。internal の公開自体は spec の非規範注記で案内） |
| D-2 (MINOR) as-is 圧縮 | 冒頭は日英 4 行要約 + 末尾「サポートと保証」節への anchor。全文は末尾へ移設（可視性と first view の両立） |
| D-3 (MINOR) 重複圧縮 | dry-run 独立節を廃止し「コマンド」節の `--dry-run` 項へ統合（安全性・API 消費・ゲート挙動は保持）。CI 最小構成もコマンド節末尾へ。nested shape は公開仕様書 §10.2 へ委譲 |

## 検証

- `git ls-files examples/` に `ksql.config.example.json` が載ることを確認（旧名の残存参照 0 件 — internal の歴史記録を除く）
- リンク検査: README・spec・template の相対リンクすべて解決（残る 2 件はレビュー文書自身の引用表記で歴史記録として残置）
- `npm test`: 13 suites / 146 tests 全通過（実装無変更の確認）
- 未検証（公開後 smoke に委ねる項目）: GitHub / npm live ページでのバッジ・リンク書き換え・raw URL の実表示（レビューの再レビュー条件どおり公開直後に実施）
