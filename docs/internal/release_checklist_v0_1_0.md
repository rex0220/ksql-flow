# kSQL Flow 初回公開チェックリスト（v0.1.0）

**対象リポジトリ**: ksql-flow
**前提**: fix4 完了（設計書 v2.8 の主要機能すべて実装済み・縮退/保留ゼロ・E-1〜E-6 全クローズ・コミット `6ece2c9`）
**担当**: 各項目に明記（Codex = 実装セッション / Claude Code = レビューセッション / **Takashi = 人間にしかできない操作**）
**最終更新**: 2026-08-22

バージョンは **v0.1.0** とする（機能は揃っているが実運用実績ゼロのため、1.0.0 は実ジョブでの安定稼働実績が積まれてから）。

---

## Phase 0: 実機検証（公開ゲート — これを通るまで公開しない）

これまでの 100 テスト + 独立シナリオはモック / 録画ベース。**実 kintone ドメインでの通し検証**が公開の最終条件。

| # | 項目 | 担当 |
| --- | --- | --- |
| 0-1 ✅ | 検証用 kintone 環境の用意（dev ドメイン・受注 / 顧客マスタ相当のアプリ・API トークン発行） | Takashi |
| 0-2 ✅ | `init-logapp` でログアプリ実生成（実際は browser console 方式 — 検証記録 §3） → `--check-logapp` 通過（`job_key` 重複禁止設定まで） | Codex |
| 0-3 ✅ | サンプルジョブ（設計書 3.1）の `validate` → `--dry-run` → `run` の通し。ログアプリの JOB レコード・メトリクス実値を目視確認 | Codex + Takashi |
| 0-4 ✅ | 異常系の実機再現: ASSERT 違反（Exit 2・通知 1 通）/ 対象 0 件（Exit 0・通知なし）/ 二重起動（Exit 5）/ `--resume`（as-of 引き継ぎ） | Codex |
| 0-5 ✅ | Webhook 通知の実受信確認（実 URL で 1 回） | Takashi |
| 0-6 ✅ | Windows 実機での動作確認（`ksql-flow` 単一バイナリ or npm 版・タスクスケジューラから 1 回起動）— 主要ターゲット環境のため必須 | Takashi |
| 0-7 ✅ | 結果を `docs/release_verification_v0_1_0.md` に記録（実行コマンド・確認結果・スクリーンショット任意） | Codex |

## Phase 1: リポジトリの公開準備

| # | 項目 | 担当 |
| --- | --- | --- |
| 1-1 | **秘密情報スキャン**: 全ファイル + 全コミット履歴（コミットは少数なので全件目視可）に、実ドメイン名・トークン・個人情報が無いことを確認。`gitleaks` 等の機械スキャン + 目視。examples / テストフィクスチャは `example.cybozu.com` 系のみであること | Codex（結果を Claude Code が再確認） |
| 1-2 | `docs/` の公開判断: reviews / 裁定ログは**公開して良い**（開発過程の透明性は as-is 製品の信頼材料）。ただし 1-1 のスキャン対象に含める | Takashi（最終判断） |
| 1-3 | `.gitignore` 確認: `.ksql/`（lock / state / logs）・`node_modules`・ビルド生成物・ローカル config | Codex |
| 1-4 | `package.json` 整備: `name: @rex0220/ksql-flow`・`version: 0.1.0`・`license: MIT`・`bin`・`engines: node >=18`・`repository` / `homepage` / `bugs`（GitHub URL）・`files`（dist + template〈ログアプリ テンプレート zip・2026-08-22 裁定で追加〉 + README + LICENSE）・`keywords`（kintone, sql, etl, batch, cli, dataops） | Codex |
| 1-5 | README 最終化: 冒頭の as-is / no support 宣言（既存）・インストール・クイックスタート（jobs 1 本 + config 最小例）・Exit Code 表・**エンジン × dialect × flow 互換表**（flow 0.1.0 ⇔ engine ^3.71.0 ⇔ dialect 1）・「商用サポートが必要なら SIer の有償サービスへ」の案内 | Codex |
| 1-6 | examples/ 最終確認: 4 環境（GitHub Actions / タスクスケジューラ / cron / Docker）が現行 CLI フラグと一致 | Codex |
| 1-7 | CHANGELOG.md 作成（v0.1.0 の 1 エントリ。以後のリリースで積む） | Codex |
| 1-8 | `npm pack` して tarball の中身を実測確認（dist のみ・ソースマップ / テスト / docs が混入していない）→ tarball から別ディレクトリへ install して CLI スモーク（`--help` / `validate`） | Codex |
| 1-9 | 公開版 CI（GitHub Actions）: push / PR で test + build。エンジンはレジストリ pin。公開リポジトリでグリーンバッジが見えることは as-is 製品の数少ない品質シグナルなので v0.1.0 に含める | Codex |

## Phase 2: GitHub 公開

| # | 項目 | 担当 |
| --- | --- | --- |
| 2-1 | `rex0220/ksql-flow` を public で作成・`main` を push | Takashi（作成）→ Codex（push はどちらでも） |
| 2-2 | **リポジトリ設定: Issues 無効化・Discussions / Wiki / Projects オフ**（サポートポリシー 15.1 の構造的クローズ。忘れやすいので公開直後に必ず） | Takashi |
| 2-3 | タグ `v0.1.0` + GitHub Release 作成（リリースノート: 概要・as-is 注意・互換表・既知の制限〈run-all --dry-run のデータ依存非再現・Q7 の診断情報扱い〉） | Codex 起草 → Takashi 発行 |
| 2-4 | Windows 単一バイナリを Release アセットとして添付（チェックサム付き、設計書 15 章） | Codex |

## Phase 3: npm 公開

| # | 項目 | 担当 |
| --- | --- | --- |
| 3-1 | `npm publish --access public`（@rex0220 スコープ） | Takashi（認証が必要） |
| 3-2 | 公開版の実測確認（エンジン側 B170 と同じ流儀）: `npm view` で latest 確認 → まっさらな環境で `npm i -g @rex0220/ksql-flow` → `ksql-flow --help` と `validate` スモーク | Codex |

## Phase 4: 公開後

| # | 項目 | 担当 |
| --- | --- | --- |
| 4-1 | kintone-sql-tools 側 README に ksql-flow への相互リンク + 互換表更新（エンジン側 Claude Code へ 1 行依頼） | Codex 起票 |
| 4-2 | 設計書 v2.8 に「v0.1.0 公開済み」の状態を記録（付録 C） | Codex |
| 4-3 | アナウンス（ブログ / X / kintone コミュニティ）は任意・Takashi の判断。文面ドラフトが必要なら依頼 | Takashi |

---

## 進め方

Phase 0 → 1 は並行可（0 の環境待ちの間に 1 を消化）。**Phase 0 が全通過するまで Phase 2 以降に進まない**。各 Phase 完了時に Claude Code が該当項目を検証（特に 1-1 の秘密スキャンは独立再実行）し、チェック結果を `docs/release_checklist_v0_1_0.md` に ✅ で追記していく。全 ✅ で v0.1.0 公開完了。
