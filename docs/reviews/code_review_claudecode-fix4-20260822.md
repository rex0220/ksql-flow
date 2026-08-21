# 修正差分レビュー（Claude Code / fix4 — dry-run 本実装・エンジン ^3.71.0）

- レビュー日: 2026-08-22
- 対象: fix4 差分（`docs/reviews/fix_response_codex-20260821.md` の fix4 節。16 ファイル +733/-93）
- 根拠: `docs/flow_dryrun_task.md` ／ 申し送り v3.71.0（R2 確定契約 6 件 + EXIT 全ゼロ仕様）／ 設計書 v2.8
- 指摘集計: BLOCKER 0 件 / MAJOR 0 件 / MINOR 0 件

## 検証結果（すべて実行して確認）

1. `npx jest`: 9 suites / **100 tests 全通過**（93 → 純増 7）。`npm run build`: 成功。
2. **受け入れ基準 1〜6 を独立再現シナリオで実証 — 7 件 ALL PASS**（verify_fix4.js）:
   - V1 サンプルジョブ dry-run: §10.2 形式（`INSERT 1 件 / UPDATE 1 件 / DELETE 0 件`・before → after サンプル・実測 API 消費）を出力し、**ミューテーション系リクエスト 0 件・ログアプリレコード 0 件・ローカルロックなし**・Exit 0
   - V2 マイナス売上: 「ABORTED になる」表示 + **Exit 2**・ミューテーション 0 件
   - V3 対象 0 件: 「NO_DATA になる」表示 + **Exit 0**
   - V4 maskFields（**UPSERT...SELECT 形式**で検証 — fix3 の迂回パターンの再発なし): サンプルのキー値・対象列が `***`・生値の漏えいなし
   - V5 `--sample 0` → Exit 1（読取前に停止）／ `--json` → 単一 `DRY_RUN` オブジェクトとして parse 可能・sampleLimit 反映
   - V6 `--max-api-calls 2` → **Exit 3 で安全停止**（発行リクエスト 2 件・ミューテーション 0 件）
   - V7 `run-all --dry-run`: 冒頭に「データ依存は再現されません」注意・依存順で両ジョブをプレビュー・ロックファイルなし・ログアプリ 0 件
3. **副作用ゼロの構造確認**: HTTP 層ガードは「GET/HEAD/OPTIONS + cursor の POST/DELETE のみ許可、他の `/k/v1/*` 非 GET は下位 fetch 到達前に `DryRunMutationError`」という fail-closed 設計（records.json 以外の将来経路も遮断）。dry-run 経路はロック・ログアプリ・state のコードパス自体を通らない。エンジン側の二重遮断（v3.71.0 §1-6）と合わせ三重防壁。
4. 観点 E: エンジンリポジトリへの変更は許可された申し送り 1 ファイルのみ（`flow_fix4_dryrun_completion_20260822.md`）。使用 API は `/flow` 公開契約のみ（`previewStatement` / `PreviewResult` / `PreviewSample`）。依存は `^3.71.0`（レジストリ）+ `dev:engine-local` スクリプトでローカル結合という指示どおりの構成。本レビューのテストはローカル symlink（同一バージョン 3.71.0）で実行。
5. R2 契約との照合: counts 3 キー・サンプル 5/50・DELETE キーのみ・reads/estimatedWrites・context 共有・書込 0 の全件をそのまま利用（差異なし）。**EXIT 成立の判定は `executeStatement` の `EXIT_NO_DATA` で行い成立後は打ち切る** — v3.71.0 §2 の「全ゼロ preview」に依存しない正しい実装。
6. ドキュメント: 設計書 v2.8 の §10.2 確定・「縮退/E-2 待ち」注記の除去（残存する「縮退」は v2.6/v2.7 の履歴記述のみ）・CLAUDE.md / AGENTS.md の仕様の正 v2.8 更新・README の dry-run/CI 例更新を確認。新規裁定なし（run-all --dry-run は指示書の明示案どおりで判断が割れず）。

## 補足（指摘ではなく記録）

* `stripLiterals` 有効時はサンプル値を一律 `?` にする実装。SQL リテラル除去（8.4 本来の対象）からの拡張解釈だが、安全側でありレポートにも明記されているため妥当。
* dry-run 中の validate で `maxApiCalls` 超過を診断メッセージの正規表現（`maxApiCalls=\d+`）で Exit 3 に分類する箇所は、自リポジトリの `ApiLimitError` メッセージへの依存であり許容範囲（将来メッセージを変える場合は連動修正）。

## 総合判定

**通過。** これで設計書 v2.8 の主要機能はすべて実装済みとなり、縮退・保留はゼロ。エンジンへの依頼 E-1〜E-6 も全件クローズ（v3.71.0 申し送り §5）。次フェーズは「初回公開チェックリスト」。
