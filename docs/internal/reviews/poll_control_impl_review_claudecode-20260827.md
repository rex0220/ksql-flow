# 実装レビュー — リラン指示ポーラー第 1 段階（my-ksql-jobs）

* 対象: `my-ksql-jobs` の `scripts/poll_control.mjs`（525 行）/ `scripts/poll_control.sh` / `poll-control.config(.example).json` / `test/poll_control.test.mjs`（54 テスト）/ `docs/poll_control_setup.md`（Codex・2026-08-27）
* レビュー: Claude Code・2026-08-27
* 正: `rerun_trigger_implementation_plan.md`（レビュー 3 巡承認済み）
* 判定: **MAJOR 2 件を修正のうえ承認**（修正は Claude Code が直接適用・全テスト再パス）

## 検証したこと

* `node --test`: **54 pass / 0 fail**（レビュー後の修正込みで再実行）
* `node --check`: 両 .mjs 通過
* 禁止パターン監査（自分で再実施）: `sh -c` / `exec` 系 / `git` / `curl` の起動なし。テンプレート補間のヒットは URL パラメータとエラー文字列のみでコマンド組み立てではない
* トークン: `process.env[tokenEnv]` で読み、ヘッダー送出のみ。ログ・書き戻し・例外に出さない。異常終了時の stderr は固定文言 1 行
* `poll-control.config.json` にトークン値なし（env 変数名のみ）。example は example.cybozu.com
* 計画との対応: 候補クエリ 1 条件・rerun_state による 5 分類・stale 別処理・status のコード判定 + `CANCELED`・チェック不変条件（終端解除 / Exit 5 維持 / claim 中維持）・証跡の取り直し規則・revision 連鎖 + 競合時再 GET 1 回再適用・`findBatchId` の 0/1/2 件規則・固定要約辞書（§6.7 と一字一致）・DoS 上限・`--check` の 10 フィールド契約検査・起動時検証（TTL vs ポーリング空白含む）— **すべて計画どおり**
* レビュー 3 巡目の注記 2 件: `CLAIMED` を上限にカウントする判断がコードコメントで明示済み。リマインダー検知範囲外の運用が setup 文書に記載済み

## MAJOR（修正済み）

### 1. kintone の日時形式にミリ秒が混入する（実機で確実に失敗）

`Date#toISOString()` は `2026-08-27T12:34:56.789Z` を返すが、kintone の DATETIME 値とクエリ日時リテラルは `yyyy-MM-ddTHH:mm:ssZ` である。

* `makeClaimFields` の `rerun_claim_expires_at` — claim PUT がエラーになる恐れ
* `findBatchId` のクエリ `started_at > "<ms 付き>"` — **Exit 5 以外の全リランで結果確定 GET がクエリエラー**になる

ローカルモックは形式を検証しないためテストでは検出されない。実機ドリル 2（Exit 0）で最初に踏む。

**修正**: `toKintoneDateTime(ms)`（ミリ秒を除去）を新設し、両箇所で使用。テスト側にあった**旧仕様（ミリ秒付き）を期待する assert を 1 件訂正**。

### 2. `evidenceMatches` の `rerun_requested_at` 厳密文字列比較

書いた文字列が kintone 側の表記正規化でそのまま返らない場合、結果 PUT の競合再適用が常に `abandoned` になる（安全側だが可用性が下がる）。**修正**: `Date.parse` の時刻値比較に変更（パース不能は不一致 = 従来どおり安全側）。

## 問題なしと確認した点（抜粋）

* claim PUT は `retryable: false` — 応答喪失時に再送せず stale 回収へ委ねる（計画 §8.5 どおり）
* `spawnRunner` の spawn 失敗 / `error` イベントは `{code:null}` → `UNKNOWN`（成功を推測しない）
* `validateConfig` が `command` の basename を `run_batch.sh` に固定・`args` を `['--resume']` に固定 — 設定ファイル改ざんへの多重防壁
* `candidateLimit >= maxCheckedRequests + overflow + stale` の整合検証 — 上限処理が取得漏れしない
* redirect は同一 origin・GET のみ・3 回まで。応答サイズ上限つきストリーム読取
* Windows 上では flock の実競合テストが実行できないため契約の静的検査に留まる — VPS ドリル 7 で実測する前提（妥当）

## 判定

**承認。** VPS 配備 → 実機ドリル 14 本（計画 §10.3）へ進める。配備時は `poll-control.config.json` の `host` を VPS の `hostname` 実値に合わせ、`--check` を先に実行すること。
