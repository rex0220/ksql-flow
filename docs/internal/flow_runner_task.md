# 実装タスク指示書: kSQL Flow ランナー（CLI）実装

**対象リポジトリ**: ksql-flow（本リポジトリ・MIT）
**担当**: Claude Code
**最終更新**: 2026-08-21

**必読ドキュメント（本リポジトリ内・この順で読むこと）**:

1. `docs/ksql_flow_design_v2_5.md` — 構想設計書（仕様の正。申し送りの前提訂正は反映済み）
2. `docs/kSQLエンジンからの申し送り-20260821-v3690.md` — エンジン側完了報告（v2.5 に反映済みだが、API シグネチャ・注意点の一次資料として読むこと）
3. エンジンの利用者向け文書: kintone-sql-tools の言語リファレンス §27・バッチレシピ R18・README「公式 API」節（`../kintone-sql-tools` がローカルにある前提。なければ npm パッケージ内の README を参照）

---

## 0. 前提

### 0.1 役割分担（再掲）

エンジン（kintone-sql-tools v3.69.0+）が SQL の解析・検証・文単位実行を提供済み。本タスクは**その上のランナー**を作る: CLI・設定ファイル・オーケストレーション・排他ロック・リラン・ログアプリ記録・リトライ・通知。**SQL の解析や実行ロジックを本リポジトリに再実装してはならない**。すべて公式 API `@rex0220/kintone-sql-tools/flow` 経由で行う。

### 0.2 設計書 v2.4 からの前提訂正（申し送りによる上書き — 実装はこちらに従う）

| 設計書の記述 | 訂正後の事実 |
| --- | --- |
| 書込は bulkRequest（2,000 件）単位で原子性 | **bulkRequest 未実装。書込チャンクは 100 件/リクエストのみ**。原子性・チェックポイント粒度とも 100 件単位 |
| チェックポイントは bulkRequest 単位 | **100 件チャンク単位**で記録 |
| EXPLAIN / 推定 API 消費は bulkRequest = 1 回 | `ceil(N/100)` の HTTP リクエスト数 |
| `SELECT ... INTO #t` が既存正 | 既存正は `CREATE TEMP TABLE #x AS SELECT ...`（動作に影響なし） |
| 1 スクリプトの文数は任意 | **上限 20 文**（超過はエンジンがエラー）。validate 時に分かりやすく表面化させること |
| 時刻関数は as-of 固定 | **`@` 付き関数のみ** as-of 固定。`@` なし（`TODAY()` 等）はサーバー評価で対象外（`KSQL1306` 警告）。サンプル・ドキュメントは `@` 付きに統一 |
| MCP `ksql_validate` でフル検証 | MCP はネットワーク 0 の契約で updateKey 検証が載らない。**ランナーの validate は `validateScript(source, { client })` を使ってフル検証**する |

### 0.3 絶対条件

1. **エンジンリポジトリ（../kintone-sql-tools）を変更しない**。エンジン側に不足を見つけたら、コードを書かずに「エンジンへの質問・依頼」として報告に載せる。
2. **MIT・サポートなし・テレメトリなし**。外部通信は (a) 設定された kintone、(b) 設定された通知 Webhook のみ（設計書 12 章）。
3. 認証情報をログ・エラーメッセージ・例外に出力しない（設計書 8.4）。
4. 大きな設計判断はコード変更前に提案。仕様が割れる点は**推奨案付きの質問**として戻し、勝手に確定しない。

---

## 1. 成果物の全体像

```
ksql-flow/
├── src/
│   ├── cli.ts              # コマンド定義（ksql-flow validate / run / run-all / unlock / init-logapp）
│   ├── config.ts           # ksql.config.json の読込・検証・extends 解決（設計書 9 章）
│   ├── orchestrator.ts     # ジョブ列挙・depends_on グラフ・SKIPPED 伝播（4 章 / 3.3）
│   ├── executor.ts         # 1 ジョブ実行: /flow の文単位実行ループ + ステータス集約（3.2 / 5 章）
│   ├── locking.ts          # ローカルロック + ログアプリ分散ロック + バッチロック（5.5）
│   ├── logging/            # ログアプリ書込・ローカル JSONL フォールバック・再送・マスキング（8 章）
│   ├── retry.ts            # 指数バックオフ + Retry-After（7 章）→ §4 の調査結果に依存
│   ├── notify.ts           # Webhook 通知・heartbeat（7.3）
│   └── state.ts            # .ksql/state.json・as-of 引き継ぎ・resume（5.3 / 6 章）
├── examples/               # サンプル jobs/・セットアップ例（設計書 付録 A を実ファイル化）
├── test/                   # ユニット + 結合（エンジン実体を使う）
└── package.json            # bin: ksql-flow / dep: @rex0220/kintone-sql-tools（開発中は file:../kintone-sql-tools）
```

* TypeScript / Node 18+。CLI フレームワーク・テストランナーは既存 kintone-sql-tools と同じものに合わせる（調査して決定・報告）。
* コマンド名は `ksql-flow`（設計書 15 章。`ksql` は既存 CLI と衝突するため使わない）。

## 2. 実装スコープ（設計書の章 → 実装）

| # | 機能 | 仕様の正 | 補足 |
| --- | --- | --- | --- |
| A | `ksql.config.json` | 9 章 | `extends` は **`apps` / `logApp` を継承しない**（9 章の事故防止規定）。`env:` 参照の解決。設定不備は Exit 1 |
| B | `validate` / `validate-all` | 10.1 / 0.2 | `validateScript(source, { client, strict })` でフル検証。診断（`KSQL1xxx`・行/列）を整形表示。`--strict` 対応 |
| C | `run`（単一ジョブ） | 3 / 5 章 | `createExecutionContext({ asOf, timezone })` → 文ループ → `disposeExecutionContext`。結果種別 → ステータス変換は §3 の表に従う |
| D | `run-all` | 4 章 | ファイル名順 + `depends_on` グラフ。既定 = 依存先のみ SKIPPED / `--stop-on-error` / `--continue-on-error` |
| E | 排他ロック | 5.5 | ローカル `.ksql/lock`（PID・ホスト・開始時刻・stale 回収）+ ログアプリ `job_key` 先行 INSERT + バッチロック `{profile}:__batch__` + **fail-closed**（`--lock local-only` で明示緩和）+ `unlock` コマンド |
| F | リラン | 6 章 | `--resume`（ログアプリが正・state.json はフォールバック・**as-of 自動引き継ぎ**）/ `--from` / `--only` |
| G | ログアプリ記録 | 8 章 | BATCH / JOB 親子レコード・8.2 の全フィールド・65,535 字対策の切り詰め・ローカル JSONL フォールバック + 次回再送・`maskFields` / `stripLiterals` |
| H | リトライ | 7 章 | §4-1 の調査結果に従う（エンジン側クライアントとの分担を先に確定） |
| I | 上限制御 | 7.2 | `--max-api-calls` / `limits.maxApiCalls`。カウントは HTTP リクエスト数・ログ / ロック分も含む単一カウンタ（§4-2 参照） |
| J | 通知 | 7.3 | `onFailure` Webhook（汎用 JSON POST）・`heartbeat`。NO_DATA は通知しない（3.2） |
| K | Exit Codes | 10.3 | 0〜5。run-all の集約規則（3 > 2 > 5 > 1、continue-on-error 混在 = 4）を厳密に |
| L | `init-logapp` / `--check-logapp` | 付録 B | kintone アプリ作成 API で 8.2 定義のログアプリを生成・検査 |
| M | `--dry-run` | 10.2 | **§4-4 の調査後に着手**（MVP は縮退版で可） |

タイムアウト（`@ksql timeout` / `limits.batchTimeoutSec`）はランナーの責務（エンジンは解析のみ）。実装は「実行中 API 呼び出しの完了を待って中断」（7.1）。

## 3. 実行結果 → ステータス / Exit Code 変換表

| エンジンの結果 / 事象 | ジョブステータス | Exit（単発 run） |
| --- | --- | --- |
| 全文 `STATEMENT` / `ASSERT_PASSED`（+ WARNING 許容） | `SUCCESS` | 0 |
| `EXIT_NO_DATA`（以降 skipped: "exit"） | `NO_DATA` | 0 |
| `ASSERT_VIOLATION` | `ABORTED` | 2 |
| validate エラー・設定不備・文数超過 | `FAILED` | 1 |
| API / 認証 / ネットワーク（リトライ上限超過含む） | `FAILED` | 3 |
| タイムアウト | `TIMEOUT` | 3 |
| ロック取得失敗 | `LOCKED` | 5 |

`ASSERT_WARNING` は続行し、警告として JOB レコードの `log_detail` へ記録する。

## 4. 最初の調査フェーズ（コードを書く前に結果を報告）

エンジン `/flow` API の実物を確認し、以下を確定させる。**不足があれば「エンジンへの質問・依頼」リストに落とす**（実装で無理に回避しない）:

1. **リトライの分担**: `createKintoneClient` に 429 / 5xx リトライ・Retry-After 対応・fetch 差し替え・リトライ hook があるか。無ければ推奨案(fetch ラッパー注入 or エンジン側依頼)を添えて質問。
2. **メトリクス取得**: `executeStatement` の戻り値・ExecutionContext から read_count / written_count / api_calls / last_written_key（100 件チャンク粒度）が取れるか。HTTP リクエスト数の計上 hook はあるか。
3. **実行中の進捗コールバック**: チェックポイント記録（5.1-2、チャンクごと）に使えるイベント / コールバックの有無。
4. **dry-run**: `executeStatement` に書込抑止モードがあるか。無い場合の MVP は「`validateScript` フル検証 + `explainScript` の推定表示」まで(差分サンプルなし)とし、差分プレビューはエンジンへの依頼として起票する。
5. `explainScript` の出力形式（10.2 の表示に必要な情報が揃うか）。
6. `KsqlFlowError` の構造（エラー分類 → Exit 3 系の判定に使えるか。認証エラーとレート系の区別）。

## 5. マイルストーン（各段でテストを通してから次へ）

1. **M1**: config 読込 + `validate` / `validate-all`（Exit 0/1 のみ）。エンジン結合テストの土台（`file:../kintone-sql-tools` 依存 + モック kintone サーバー or 録画レスポンス。方式は調査して提案）
2. **M2**: `run` 単発実行（文ループ・as-of/timezone・§3 の変換・ローカル JSONL ログ・Exit 0/1/2/3）
3. **M3**: ログアプリ記録（親子レコード・切り詰め・マスキング・再送）+ `init-logapp` / `--check-logapp`
4. **M4**: 排他ロック一式（E）+ `unlock` + Exit 5
5. **M5**: `run-all`（依存グラフ・集約 Exit・`--stop-on-error` / `--continue-on-error`）+ `--resume` / `--from` / `--only`（as-of 引き継ぎ）
6. **M6**: リトライ / 上限制御 / タイムアウト / 通知・heartbeat
7. **M7**: `--dry-run`（§4-4 の結論に従う）+ examples/ 整備（設計書 付録 A の 4 環境を実ファイル化）+ README 更新

## 6. 受け入れ基準

1. 設計書 3.1 のサンプルジョブ（`@` 付き時刻関数版）が `ksql-flow run` で実行でき、ログアプリに JOB レコードが正しく残る。
2. マイナス売上を仕込むと `ABORTED` (Exit 2)・通知あり、対象 0 件だと `NO_DATA` (Exit 0)・**通知なし**。
3. 同一プロファイルの二重起動が Exit 5 で止まり、終了後は `job_key` がクリアされ翌実行が通る。stale ロックが自動回収される。
4. `--resume` が失敗ジョブのみを元の as-of で再実行する（テストで as-of 値を検証）。
5. ログアプリ到達不能時: 開始時は fail-closed（Exit 3・何も書き込まない）、実行中はローカル JSONL に記録され次回再送される。
6. run-all の Exit 集約が 10.3 の全ケース（0/3/2/5/1 優先・混在 4）をテストで網羅。
7. `limits.maxApiCalls` 超過で安全停止。カウントにログ・ロック分が含まれることをテストで確認。
8. トークン等の秘密が全ログ・全エラー出力に現れないことをテストで確認。
9. README に使い方・Exit Code 表・エンジン × dialect × flow の互換表を記載。

## 7. 完了報告に含めること

変更ファイルと各マイルストーンの要約、§4 の調査結果と「エンジンへの質問・依頼」リスト、実装した CLI フラグ一覧、未実装 / 縮退項目（dry-run の到達点など）、結合テストの実行方法。
