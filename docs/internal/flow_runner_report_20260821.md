# ランナー実装 完了報告（タスク指示書 §7）

**日付**: 2026-08-21 ／ **担当**: Claude Code（ランナー実装）
**結果**: M1〜M7 完了。テスト 64 件全通過（`npm test`）・`npm run build` 成功・エンジンリポジトリへの変更なし。

---

## 1. 変更ファイル一覧

```
package.json / tsconfig.json / .gitignore     # プロジェクト設定（エンジンと同じ jest + ts-jest / TS strict / 自前引数パーサ）
src/
├── cli.ts                  # コマンド定義・引数解析・Exit Code 変換
├── config.ts               # ksql.config.json 読込・extends 解決（apps/logApp 非継承）・env: 解決・検証
├── http.ts                 # fetch ラッパー: 単一 API カウンタ・429/5xx リトライ + Retry-After・書込チャンク観測・Basic 併送
├── runner.ts               # コマンド共通環境の組み立て（--as-of 解析・実効タイムアウト）
├── executor.ts             # 1 ジョブ実行: 文ループ・§3 のステータス変換・チェックポイント・終了更新
├── jobs.ts                 # *.sql 列挙（ファイル名順）・@ksql メタ・依存グラフ検証・文数上限
├── lock.ts                 # ローカルロック（O_EXCL・PID 生存確認・stale 回収）
├── logapp.ts               # 8.2 フィールド定義・job_key 分散ロック・切り詰め・stale 回収・再送・resume 読取
├── state.ts                # .ksql/state-<profile>.json（resume のフォールバック）
├── notify.ts               # onFailure Webhook / heartbeat
├── errors.ts               # エラー分類（Exit 1/3/5 の判定・cause チェーンの HTTP status 探索）
├── logging/mask.ts         # SecretMasker（既知秘密の伏字化）・stripSqlLiterals・maskFields
├── logging/jsonl.ts        # ローカル JSONL ログ・再送キュー
└── commands/
    ├── validate.ts         # validate / validate-all（validateScript フル検証）
    ├── run.ts              # run（単発実行 + 通知）
    ├── runAll.ts           # run-all（依存グラフ・SKIPPED 伝播・resume/from/only・Exit 集約・バッチロック）
    ├── dryrun.ts           # --dry-run 縮退版（フル検証 + EXPLAIN 推定。@関数の as-of リテラル置換）
    ├── unlock.ts           # ロック明示解除
    └── initLogapp.ts       # init-logapp / --check-logapp
test/
├── helpers/mockKintone.ts  # インメモリ kintone エミュレータ（records/cursor/fields/重複禁止/429 注入/preview API）
├── helpers/world.ts        # 受注/顧客マスタ/実行ログの結合テスト環境
└── __tests__/*.test.ts     # 9 スイート 64 テスト
examples/                   # 付録 A の 4 環境 + サンプル jobs + config（validate-all でテスト済み）
docs/flow_runner_survey_20260821.md   # §4 調査報告（実装前に作成）
README.md                   # 使い方・Exit Code 表・互換表・as-is 表記
```

## 2. マイルストーン要約

| M | 内容 | 状態 |
| --- | --- | --- |
| M1 | config 読込 + validate / validate-all。結合テスト方式 = **モック kintone を fetch 注入**（録画方式は不採用） | ✅ |
| M2 | run 単発実行（文ループ・as-of/timezone・§3 変換・JSONL・Exit 0/1/2/3） | ✅ |
| M3 | ログアプリ記録（BATCH/JOB 親子・切り詰め・マスキング・JSONL フォールバック + 再送）+ init-logapp / --check-logapp | ✅ |
| M4 | 排他ロック一式（ローカル + job_key 分散 + バッチ + fail-closed + --lock local-only + stale 回収）+ unlock + Exit 5 | ✅ |
| M5 | run-all（依存グラフ・SKIPPED 伝播・集約 Exit・--stop-on-error / --continue-on-error）+ --resume / --from / --only（as-of 自動引き継ぎ） | ✅ |
| M6 | リトライ（指数バックオフ + Retry-After）/ maxApiCalls 単一カウンタ / タイムアウト / 通知・heartbeat | ✅ |
| M7 | --dry-run（縮退版）+ examples/（付録 A 実ファイル化）+ README | ✅ |

受け入れ基準 1〜9 はすべてテストで検証済み（`test/__tests__/` の run / locking / runAll / http / limits_secrets / dryrun_logapp / examples）。

## 3. §4 調査結果と「エンジンへの質問・依頼」

詳細は [flow_runner_survey_20260821.md](flow_runner_survey_20260821.md)。要点:

* **リトライ**: エンジン client にリトライなし・`fetch` 差し替え可 → ランナーの fetch ラッパーで実装（依頼不要）。エンジンの `timeoutMs` はリトライを含む全体を包むため大きく設定し、試行単位タイムアウトはラッパー側で管理。
* **メトリクス**: `metrics` はコンテキスト累積の共有参照。read_count = `fetchedRows`、written_count = DML 結果の `insertedCount` 等、api_calls = ラッパーの単一カウンタ。
* **エラー分類**: HTTP status を cause チェーン + 自前エラー型で判定。**ASSERT 文の実行中にインフラエラーが起きても kind は ASSERT_VIOLATION になる**ため、`error.code === "AssertError"` の場合のみ ABORTED に分類（実装上の重要な注意点）。

**エンジンへの質問・依頼（コードは書いていない）**:

| # | 種別 | 内容 |
| --- | --- | --- |
| E-1 | 依頼 | 書込チャンクのキー値を取得する手段（コールバック or metrics）。併せて DML 書込のキー昇順整列（5.1-2 の前提）の確認。当面 `last_written_key` は `chunk:<n>` 形式に縮退 |
| E-2 | 依頼 | dry-run（書込抑止 + 差分プレビュー）モード |
| E-3 | 依頼 | `StatementResult.result` の DML 結果型の公開契約化（written_count 集計に使用中） |
| E-4 | 質問 | `KsqlFlowError.code` の値域は公開契約か |
| E-5 | 確認 | `metrics` が累積・共有参照である仕様の明文化 |
| E-6 | 依頼 | `explainScript` に `asOf` / `timezone` オプションがなく `@NOW()` 等が変数未定義エラーになる。追加を依頼（当面はリテラル置換で回避） |

## 4. 実装した CLI フラグ一覧

| コマンド | フラグ |
| --- | --- |
| 共通 | `--profile` `--config` |
| validate | `-f/--file` `--strict` `--check-logapp` |
| validate-all | `<jobsDir>` `--strict` |
| run | `-f/--file` `--as-of` `--dry-run` `--strict`(dry-run 用) `--max-api-calls` `--lock local-only` `--force-unlock` |
| run-all | `<jobsDir>` + run と同じ + `--resume` `--from` `--only` `--stop-on-error` `--continue-on-error` |
| unlock | （共通のみ） |
| init-logapp | `--name` |

## 5. 未実装・縮退項目

1. **--dry-run**: フル検証 + EXPLAIN 推定表示まで（§4-4 の調査結論どおり）。差分サンプル・実件数の INSERT/UPDATE 内訳は E-2 の対応待ち。
2. **last_written_key**: キー値ではなく `chunk:<書込チャンク数>`（E-1 待ち）。チェックポイント自体は 25 チャンクごと or 60 秒ごとに RUNNING レコードへ書き込む。
3. **clientCert / proxy**: config は受理するが未実装（設定時は警告表示）。README の制限事項に記載。
4. **--parallel**: 設計書どおり予約のみ（順次実行）。依存グラフ検証で「依存先がファイル名順で後ろ」をエラーにしている。
5. **validate の推定 API 数表示**: validate は診断表示に専念し、推定は --dry-run に集約（10.1 からの軽微な変更）。

## 6. 仕様が割れた点（推奨案付きの質問 — 裁定待ち。実装は推奨案で仮置き）

| # | 論点 | 実装（推奨案） |
| --- | --- | --- |
| Q-1 | heartbeat は `NO_DATA` でも送るか。8.5 は「NO_DATA は通知しない」だが、これは onFailure アラートの文脈。月次ジョブは大半の日が NO_DATA になり得るため、dead man's switch が誤発報する | **送る**（Exit 0 = SUCCESS / NO_DATA の完了時に ping）。onFailure は NO_DATA で送らない（受入 2 準拠） |
| Q-2 | 依存伝播の対象。3.3 は「依存元が FAILED / ABORTED の場合のみ SKIPPED」だが TIMEOUT と、失敗起因で SKIPPED になったジョブへの依存が未言及 | **FAILED / ABORTED / TIMEOUT / SKIPPED（失敗起因）を伝播対象に含める**（TIMEOUT は失敗の一種・SKIPPED の連鎖は依存グラフの自然な帰結のため） |
| Q-3 | `run` 単発のログレコードは batch_id をどうするか | 単発 run も新規 batch_id を発行し JOB レコードのみ記録（parent_batch_id 空）。--resume の対象は run-all の BATCH レコードのみ |
| Q-4 | リトライの各試行を API カウンタに含めるか | **含める**（kintone 側の流量消費と一致させるため。7.2 の「HTTP リクエスト数」の自然な読み） |

## 7. 結合テストの実行方法

```bash
cd ksql-flow
npm install          # エンジンは file:../kintone-sql-tools（要: エンジン側で dist-flow がビルド済み）
npm test             # jest --runInBand。9 スイート 64 テスト（エンジン実体 + インメモリ kintone モック）
npm run build        # tsc → dist/。node dist/cli.js --help で CLI 確認
```

* モック kintone（`test/helpers/mockKintone.ts`）は records / cursor / form fields / 重複禁止制約 / 429・5xx・ネットワーク断の注入 / preview（アプリ作成）API を実装。`createKintoneClient({ fetch })` に注入するため**ネットワーク 0** で全受入基準を検証できる。
* 実環境での確認は `examples/ksql.config.json` を実アプリ ID・トークンに書き換えた上で `validate-all` → `--dry-run` → `run` の順を推奨。
