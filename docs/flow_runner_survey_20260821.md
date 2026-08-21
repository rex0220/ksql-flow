# ランナー実装 事前調査報告（タスク指示書 §4）

**日付**: 2026-08-21 ／ **担当**: Claude Code（ランナー実装）
**調査対象**: kintone-sql-tools v3.69.0 の公式 API `/flow`（`src/flow-library/` および `dist-flow/flow-library/*.d.ts` を実読）

---

## 1. 調査結果（§4-1〜4-6）

### 4-1. リトライの分担 → **ランナー側 fetch ラッパーで実装（エンジン依頼不要）**

* `createKintoneClient` に **リトライ機構は一切ない**。1 回の fetch を実行し、非 2xx は `KintoneHttpError`（`status` / `code` / `message` を保持、内部クラス）を throw するのみ（`writableClient.ts`）。
* `CreateKintoneClientConfig.fetch?: typeof globalThis.fetch` で **fetch の差し替えが可能**。→ ランナーは fetch ラッパーを注入し、そこで 429 / 500 / 502 / 503 / 520 / ネットワークエラーの指数バックオフ + Retry-After 尊重を実装する。
* **注意点**: エンジンの `timeoutMs`（既定 30 秒）は AbortController で **fetch 呼び出し全体**（＝ラッパー内リトライを含む）を包む。ランナーは `createKintoneClient` へ大きな `timeoutMs` を渡し、**試行単位のタイムアウトはラッパー側で自前管理**する。
* エラー分類（§4-6 と関連）: 401 / 403 は即時中断（リトライなし）。ラッパーが HTTP status を直接観測できるため、Exit 3 系の分類はランナー側で完結する。

### 4-2. メトリクス取得 → **概ね可能。`last_written_key` のみ不可（エンジンへ依頼）**

* `StatementResult.metrics: ExecutionMetrics` は **ExecutionContext 全体の累積値**（`managed.metrics` の共有参照。`createManagedStatementExecutionContext` が `wrapClientWithMetrics(client, metrics)` で単一オブジェクトに集計）。文単位の値が必要な場合はランナーでスナップショット差分を取る。
* `read_count` ← `metrics.fetchedRows`（カーソル読取は `cursorRecordsScanned` も併記可能）。
* `written_count` ← `StatementResult.result` の DML 結果オブジェクト `{type:"INSERT"|"UPDATE"|"UPSERT"|"DELETE", insertedCount, updatedCount, deletedCount}` を合算（※ `result` の型は公開契約上 `unknown` — 依頼 E-3 参照）。
* `api_calls` ← **fetch ラッパーの HTTP リクエストカウンタを正とする**。ログアプリ書込・ロック操作も同一ラッパー経由にすることで、設計書 7.2 の「単一カウンタ」要件を構造的に満たす。エンジンの `getCalls`/`postCalls` 等は参考値扱い。
* `last_written_key`（100 件チャンク粒度）は **エンジンから取得不可**（metrics にもコールバックにも存在しない）→ 依頼 E-1。

### 4-3. 実行中の進捗コールバック → **エンジンに無し。fetch ラッパーで代替可能**

* `CreateExecutionContextOptions` にイベント / コールバックは存在しない。
* ただし書込チャンク（100 件/リクエスト）は **必ず POST / PUT / DELETE `/k/v1/records.json` の 1 HTTP リクエストに対応**するため、fetch ラッパーがリクエスト単位のフック（対象アプリ・件数）を提供でき、**チャンク粒度のチェックポイント記録（5.1-2）はキー値以外は実現可能**。キー値の記録は E-1 の依頼が通るまで「書込チャンク数 + 処理件数」ベースに縮退する。

### 4-4. dry-run → **書込抑止モードは無し。MVP は縮退版**

* `executeStatement` / `CreateExecutionContextOptions` に書込抑止（dry-run）オプションは無い。SQL 構文の `VALIDATE ONLY` は存在するが、ユーザー SQL の書き換えが必要になるため採用しない。
* **MVP**: `validateScript(source, { client, strict })` フル検証 + `explainScript` の推定 API 消費表示（差分サンプルなし）。差分プレビューは依頼 E-2 として起票。

### 4-5. explainScript の出力形式 → **縮退版 dry-run には十分**

* 戻り値: `{ statementCount, statements: [{ index, type, plan: string[] }] }`。dialect 1 では各文の plan に `estimated API consumption (dialect 1):` 以下、読取（500 件/回）・metadata GET・UPSERT pre-read・書込（100 件/回、`ceil(N/100)`）の内訳行が含まれる。件数不明の項は「不明（上限 N と仮定: 最大 M 回）」形式。
* 10.2 の完全な表示（実件数・INSERT/UPDATE 内訳・変更サンプル）には足りないが、縮退版（推定値の転記）には十分。

### 4-6. KsqlFlowError の構造 → **分類はランナーの fetch ラッパー起点で行う**

* `KsqlFlowError { code: string; message; cause? }`。`normalizeFlowError` で全エラーがこれに正規化される。`StatementResult.error` は `{ code, message, cause? }`。
* HTTP 由来のエラーは cause チェーンに `KintoneHttpError`（`status: number` プロパティ）がぶら下がる。ランナーは (1) 自ラッパーが throw する専用エラー（リトライ上限超過・ネットワーク）を instanceof で、(2) cause チェーン上の `status` 数値を、順に見て Exit 3 系（API / 認証 / ネットワーク）と Exit 1 系（構文・検証・実行時 SQL エラー）を判別する。`KSQL1xxx` 診断コードは Exit 1。
* 認証（401/403）とレート（429）の区別はラッパーが status で直接判定（429 のみリトライ）。

## 2. 実装方針の確定事項（調査に基づく決定）

| 論点 | 決定 |
| --- | --- |
| CLI フレームワーク | エンジン CLI と同じく**自前の引数パーサ**（実行時依存ゼロを踏襲） |
| テストランナー | **jest + ts-jest**（エンジンと同一。`testMatch: **/__tests__/**/*.test.ts`） |
| TS 設定 | エンジン準拠（ES2020 / CommonJS / strict） |
| 結合テスト方式 | **モック kintone（インメモリ）を fetch 注入**で実現。`createKintoneClient({ fetch })` に in-memory の kintone REST エミュレータ（records / cursor / form fields / 重複禁止判定 / 429 注入）を渡す。録画レスポンス方式は不採用（エンジン更新に追従しづらく、429 等の異常系を注入できないため） |
| API カウンタ | fetch ラッパーの単一カウンタ。**リトライの各試行も 1 回と数える**（kintone 側の流量消費と一致させるため） |
| validate の推定 API 数表示 | `validate` は診断表示に専念し、推定 API 消費は `--dry-run` で表示（`explainScript` はフル client が必要なため）。README に記載 |
| ログアプリ二重起動検知 | RUNNING レコードの先行 GET → INSERT。INSERT の 400 は重複制約（レース）として Exit 5 扱い |

## 3. エンジンへの質問・依頼（コードは書かず起票のみ）

| # | 種別 | 内容 |
| --- | --- | --- |
| E-1 | 依頼 | **書込チャンクのキー値を観測する手段**が無い。`CreateExecutionContextOptions.onChunkWritten?: (info: { appId, statementIndex, records: number, lastKeyValue?: string }) => void` のようなコールバック、または metrics への `lastWrittenKey` 追加を依頼。併せて **DML の書込がキー昇順に整列されているか**（設計書 5.1-2 の `last_written_key` 単調性の前提）の確認を依頼。ランナー MVP は「書込チャンク数 + 件数」のチェックポイントに縮退する |
| E-2 | 依頼 | **dry-run（書込抑止）モード**: `executeStatement` に書込 API を発行せず差分（INSERT/UPDATE/DELETE 件数と変更サンプル）を返すモードの追加。設計書 10.2 の差分プレビュー実現に必要 |
| E-3 | 依頼 | `StatementResult.result` の DML 結果（`insertedCount` / `updatedCount` / `deletedCount` 等）が現状 `unknown` 型。**公開契約としての型定義公開**を依頼（ランナーは written_count 集計に使用中） |
| E-4 | 質問 | `KsqlFlowError.code` の値域は公開契約か（`ExecutionContextDisposedError` 等）。ランナーは分類を HTTP status ベースで行うため必須ではないが、明示されれば表示を安定化できる |
| E-5 | 確認 | `StatementResult.metrics` が**コンテキスト累積の共有参照**である仕様の明文化（現実装から読解。文単位値が必要なら利用側で差分を取る、で合っているか） |
| E-6 | 依頼 | **`explainScript` に `asOf` / `timezone` オプションが無い**。dialect 1 の `@NOW()` 等を含むスクリプトを explain すると `ParseError: variable @as-of:NOW is not defined in this batch` になる（as-of 変数は `createExecutionContext` でのみ注入されるため）。`ExplainScriptOptions` への `asOf` / `timezone` 追加を依頼。ランナーの dry-run は当面、`@` 関数を as-of 基準のリテラルへテキスト置換してから explain する回避策で対応（`src/commands/dryrun.ts`） |

## 4. 補足（実装上の注意として記録）

* `createExecutionContext` は `script` を渡せば内部で parse するが、`executeStatement` は**内部で保持した statements 配列との参照一致**を要求する（`ExecutionContextOrderError`）。ランナーは `parseScript` の戻り値の `statements` をそのままループに使う（再 parse した配列は不可）。
* `continueOnError` は DML を含むバッチでは禁止（エンジンが throw）。ランナーは使用しない（既定 fail-fast のまま）。
* 文数上限 20 文はエンジンの parse / 実行時エラーとして表面化する。validate 時にランナー側でも `statements.length > 20` を検査し分かりやすいメッセージを添える。
* `init-logapp` の kintone アプリ作成 API（preview app / deploy）は API トークン非対応（ユーザー認証必須）。`auth.type: password` のプロファイルでのみ実行可能とし、CLI でその旨を案内する。
