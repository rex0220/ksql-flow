# 修正差分レビュー（Claude Code / fix5 — 公開ゲート PRE-1〜PRE-6）

- レビュー日: 2026-08-22
- 対象: fix5 差分（大局レビュー `architecture_review_codex-20260822.md` F-2 の PRE-1〜PRE-6 対処）
- 指摘集計: BLOCKER 0 件 / MAJOR 0 件 / MINOR 1 件（記録のみ・対処不要）

## 検証結果（すべて実行して確認）

1. `npx jest`: **12 suites / 135 tests 全通過**（101 → +34。cli_contract / state_contract / template_contract の 3 スイート新設）・`npm run build` 成功
2. **PRE-1 独立検証（最重要・CLI 直接実行）**: config 不在ディレクトリで dist/cli.js を直接起動し、以下すべて **Exit 1 + 明確な usage エラー**を確認。正常形のみ「設定ファイルが見つかりません」に到達 = **拒否が設定読込・API 呼び出しより前**であることを実証:
   - `--dryrun`（typo）→「コマンド run ではフラグ --dryrun を使用できません」
   - `--json` 単独 →「--dry-run との併用時のみ」
   - `--resume --only` 併用 → 排他エラー
   - `--strcit`（typo）→ 拒否
   - 余分な positional → 拒否
3. **PRE-3 独立検証**: ネストの未知キー（`logging.stripLiteral` の typo）→ **パス付き ConfigError**（`profiles.p.logging.stripLiteral: 未知の設定キーです`）。`schema/ksql.config.schema.json` 存在 + package files に `schema` 追加を確認。`formatVersion: 1` / JSONL envelope / state 警告はテストスイート（state_contract ほか）で担保
4. **PRE-2**: 設計書 **v2.9** 新規作成・CLAUDE.md / AGENTS.md / README の「仕様の正」参照更新を確認。clientCert/proxy と validate 見積りの「v0.1 非対応」統一・Q1〜Q7 不変
5. **PRE-4**: `--check-logapp` の選択肢検査（不足・過剰の個別表示）とテンプレート ZIP ⇔ `LOG_APP_FIELDS` の常設契約テスト（adm-zip は MIT devDependency・テスト専用）を確認
6. **PRE-5**: CI に Node 18 追加 + 独立 pack ジョブ（tarball 検査 → 別 prefix install → --help スモーク）。README のクイックスタート導線を package 実体に整合
7. **PRE-6**: unlock / --force-unlock の**解除前対象一覧表示**（件数・jobKey・startedAt）と「同一プロファイルの全 RUNNING が対象」の明記、対象取得不能時は何も解除せず Exit 3 — 既存テストの assertion 追加で担保

## MINOR（記録のみ）

- `test/__tests__/locking.test.ts` の stale テストに `batchTimeoutSec = 3600` 直後の `= 1` 再代入が残っている（前者は無効な行）。挙動に影響なし・次回のテスト整理時に除去でよい

## 総合判定

**通過。公開ゲート PRE-1〜PRE-6 はすべてクローズ。** 大局レビューの判定条件（「PRE-1〜PRE-5 + PRE-6 の文書化を閉じれば v0.1.0 公開可」）を満たした。POST-1〜POST-9 は公開後の課題台帳として維持。これで **Phase 2（GitHub 公開）のゲートが開いた** — 残る人間項目は 1-2（docs 公開範囲の最終判断）と 2-1（リポジトリ作成）。
