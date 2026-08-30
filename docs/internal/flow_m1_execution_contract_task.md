# M1 起票: Execution Contract v1 の実装（Phase 0 / KF-01〜KF-06）

起票: 2026-08-30（Claude Code） / 実装: Codex / レビュー: Claude Code（`flow_code_review_task.md` の往復方式）
依頼元: `docs/kSQL-FlowNetからの依頼-20260829-M1-ExecutionContract.md`
疑義 1 裁定済み（オーナー承認 2026-08-30、`docs/kSQL-FlowNetからの返信-20260830-M1疑義裁定.md` / decisions.md Q13）。**KF-01 の保留は解除済み — 全マイルストーン着手可**

## 0. 正本と読む順序（実装前に必読）

1. 依頼文書（上記）
2. `C:\Users\rex02\Projects\ksql-flownet\docs\execution-contract-v1.md`（契約本文。以下「契約」）
3. `C:\Users\rex02\Projects\ksql-flownet\docs\current-ksql-flow-changes.md`（変更点一覧・§9 受入基準 14 項目。以下「変更点」）
4. `C:\Users\rex02\Projects\ksql-flownet\spikes\e-execution-contract\execution-result-v1.draft.schema.json` + `tests\fixtures\execution-result\`（schema 草案・fixture）
5. `C:\Users\rex02\Projects\ksql-flownet\docs\phase1-freeze-decision-record.md` の D-10/D-11/D-14/D-22〜D-24/D-26/D-29 と §10 Spike E
6. 疑義返信と裁定: `docs/kSQL-FlowからkSQL-FlowNetへの返信-20260830-M1疑義.md` → `docs/kSQL-FlowNetからの返信-20260830-M1疑義裁定.md`（疑義 1 承諾・確認 2 同意・予告 11 項目異議なし。decisions.md Q13）。FlowNet 正本は ksql-flownet main `c95cbc4` で修正済み — **草案 schema・fixture は修正後のものを出発点にすること**（`sql-error.json` fixture が追加されている）

原則（依頼文書より）: 仕様と実装が食い違う場合はコードに合わせて仕様を黙って直さず、契約文書の再審議を返信文書で行う。裁定済み事項（D-08/D-10/D-11/D-29）は再提案しない。

## 1. スコープ / 非スコープ

対象:

* `run`（単一ジョブ）の Execution Contract v1 対応（KF-01〜KF-06）
* 新コマンド `capabilities` / `describe-profile` / `inspect-job` と、Job lock 回復契約の新コマンド
* ログアプリ template v0.4（相関フィールド追加）と旧 schema 互換

非スコープ（実装しない・変えない）:

* `run-all` のバッチ集約結果と dry-run の既存 `--json`（契約 §1。`--json` は dry-run 専用のまま、`DRY_RUN_BATCH` shape 不変更）
* J1 ロックキーへの移行（D-14 未決。**現行 `{profile}:{job_id}` 形式を維持** — 変更点 §5。J1 採用時は FlowNet の test vector `tests\fixtures\canonical-lock-key\vectors.json` と完全一致が受入条件になるが、本 M1 では着手しない）
* DAG / Network Run / Network lock / snapshot 等 FlowNet 側責務（変更点 §7）
* エンジンリポジトリ `../kintone-sql-tools` の変更（依頼は文書起票）
* Exit Code の再割当て（0/1/2/3/4/5 維持。上位分類は resultCode で行う）

互換性条件: FlowNet 未導入の既存利用者が従来どおり使えること（変更点 §6）。既存 `run` / `run-all` / `dry-run` / `unlock` の挙動・Exit Code・出力は、本起票が明示する箇所以外変更しない。

## 2. orchestrator モードの定義（全 KF の前提）

`run` に次の 4 フラグを追加する（`src/cli.ts` の `VALUE_FLAGS` / `COMMAND_FLAGS.run`）:

| フラグ | 値 |
| --- | --- |
| `--result-json <path\|->` | `-` = stdout、path = ファイル出力 |
| `--correlation-id <id>` | `^[A-Za-z0-9._:-]{1,128}$`（契約 §2/§10 のログインジェクション対策。`KSQL_HOST_LABEL` と同じ文字クラス） |
| `--attempt-id <id>` | 同上 |
| `--expected-job-id <id>` | SQL の論理 job ID（`JobFile.name`）と完全一致必須 |

規則（違反はすべて VALIDATION_ERROR / Exit 1 / `executionStarted=false`）:

1. **全か無か**: 4 フラグのいずれかを指定したら 4 つすべて必須（= orchestrator モード）。→ 疑義返信の確認 2（FlowNet が異議なければこの規則で確定）
2. orchestrator モードは `run` 専用。`run-all` / `--dry-run` / `--json` / `--sample` との併用は拒否
3. **`--lock local-only` との併用禁止**（契約 §8.1）。logApp 未設定も拒否
4. `--expected-job-id` は `loadJobFile()` 後・ロック取得前に `job.name` と照合。不一致は実行前拒否（受入基準 9・10 の kSQL-Flow 側担保: ロックキーは照合済み論理 job ID から生成される既存実装 `src/commands/run.ts:55` を維持）
5. ID 検証は API 呼び出し前（`src/cli.ts` の `validateArgs` 段階でできる検査はそこで行う）

## 3. KF-01: Execution Result 型・JSON Schema・resultCode

* 型は `src/contract/` 等の新モジュールに置く（配置は Codex 裁量。ただし既存 `types.ts` の `JobOutcome` は変えず、**出力境界で正規化**する — 変更点 §3）
* JSON Schema を `schema/execution-result-v1.schema.json` として同梱（`schema/ksql.config.schema.json` と同列）。**本同梱版が正本**（裁定の補足 2。FlowNet 側 draft は検証用コピーへ降格）。修正済み草案 schema（c95cbc4 以降）を出発点にし、`$id` と contract version（`ksql-flow.execution/v1`）を schema へ含める。fixture は FlowNet の `success.json` / `failure.json` / `sql-error.json` を出所コメント付きでテストへ取り込み、schema 検証を CI に入れる
* `resultCode` は閉じた enum にしない（契約 §4.3 の additive 互換。schema 上は `minLength: 1` の string + 既知コードの整合条件）

現行結果 → contract の変換表（実装の正。契約 §4.2 と変更点 §3 を現実装へ写像）:

| 現行の結果 | status | resultCode | Exit | executionStarted |
| --- | --- | --- | --- | --- |
| `SUCCESS` | SUCCESS | OK | 0 | true |
| `NO_DATA` | SUCCESS | NO_DATA | 0 | true |
| SQL 開始前の引数・設定・parse・`--expected-job-id` 不一致・as-of 不正（`ConfigError` / `executor.ts:100` の parse 早期 return / §2 の各検証） | FAILED | VALIDATION_ERROR | 1 | **false 必須** |
| SQL 開始後の SQL 実行時エラー（`classifyRuntimeError` → Exit 1 の経路 `src/errors.ts:86`） | FAILED | SQL_ERROR（**裁定済み Q13**: FAILED/Exit 1。Exit 1 は resultCode + executionStarted で判別） | 1 | true |
| `ABORTED`（ASSERT 違反） | FAILED | ASSERT_FAILED | 2 | true |
| `TIMEOUT`（ランナー検知） | FAILED | EXECUTION_TIMEOUT | 3 | true |
| HTTP 401/403（`findHttpStatus`） | FAILED | AUTH_ERROR | 3 | 到達状況どおり |
| その他 HTTP / ネットワーク / リトライ上限 / `ApiLimitError` | FAILED | API_ERROR | 3 | 到達状況どおり |
| `LockUnavailableError`（fail-closed） | FAILED | LOCK_UNAVAILABLE | 3 | false（SQL 前に発生） |
| `EXECUTION_STARTED` 永続化を確認できない（KF-04） | FAILED | LOCK_UNAVAILABLE または INTERNAL_ERROR | 3 | false |
| 予期しない内部エラー | FAILED | INTERNAL_ERROR | 3 | 到達状況どおり |
| graceful cancel 完了（KF-05） | CANCELLED | CANCELLED | 3 | 到達状況どおり |
| `LockedError`（ローカル・分散とも） | FAILED | LOCK_CONFLICT | 5 | **false 必須** |

フィールドの決定（契約 §13 → 返信文書へ記録する項目。裁定は本表を提案値とする）:

* **executionId**: `createRunnerEnv()` が生成する既存 `batchId`（UUID v4、`src/runner.ts:29`）をそのまま公開する（変更点 §2.2 の推奨案）。発行時点 = プロセス起動時（ロック取得前）。ログの `batch_id` は従来どおり維持
* **startedAt**: 最初の SQL 文開始直前の時刻（KF-04 の `runner_execution_started_at` と同一時点・UTC ISO 8601）。未開始なら null。`durationMs` = `finishedAt - startedAt`、未開始は 0
* **asOf**: `--as-of` の入力文字列をそのまま echo（検証は既存 `parseAsOf`）。省略時（standalone のみ想定）は解決した now() の ISO 文字列
* **error**: 成功時 null。`category` は `CONFIG / SQL / ASSERT / API / AUTH / TIMEOUT / LOCK / INTERNAL / CANCELLED` の 9 値から開始（additive）。`code` は安定文字列（例: `KINTONE_HTTP_403`、`ASSERT_VIOLATION`、`RETRY_EXHAUSTED`）。`message` は `SecretMasker` 適用 + 上限 2,000 文字で切り詰め（超過時 `detailsTruncated: true`）。stack trace・レスポンス本文・SQL リテラルを含めない（契約 §10、`stripSqlLiterals` 活用）
* count 類は既存 `JobOutcome` の値（`readCount` / `writtenCount` / `deletedCount` / `apiCalls`）。`lastSuccessfulChunkNo` = 既存 `writeChunks` 相当、`lastWrittenKey` = 既存診断値（マスク済み）。**未開始・未計測は 0 / null**（負数・非整数を出さない）
* version 類: `ksqlFlowVersion` = `RUNNER_VERSION`、`engineVersion` = エンジン import の `version`

## 4. KF-02: `--result-json` と stdout 純 JSON 規律

1. **stdout 規律**（契約 §6）: `--result-json -` では stdout に「UTF-8・BOM なしの JSON object 1 個 + 末尾改行」以外を一切出さない。実装方針: orchestrator モードでは `createRunnerEnv` の `out` 既定を `console.error` 系に差し替え（`src/runner.ts:32`）、リトライ待機表示・警告・`printOutcome`・notify のヒントも含め全人間向け出力を stderr へ。ANSI escape を stdout へ出さない
2. **path 出力**: 同一ディレクトリの一時ファイル（例 `.<basename>.tmp-<pid>`）へ書き、`fsync` 後に atomic rename。途中 JSON が完成結果として観測されないこと（受入基準 2）
3. **上書き規則（§13 決定・提案）**: 起動時（引数検証段階）に出力先が既存ファイルなら VALIDATION_ERROR で拒否（fail-closed。別 attempt の結果混同を防ぐ。orchestrator は attempt ごとに新しい path を渡す前提）。Windows の `fs.renameSync` 上書き挙動差にも依存しない
4. **controlled failure**（契約 §6）: `--result-json` を認識できた後の失敗は、可能な限り Execution Result を出力してから該当 Exit Code で終了する。`runCommand` を「結果オブジェクトを必ず構築 → writer で出力 → その exitCode を return」の単一経路に再構成し、`cli.ts:254` の catch-all に頼らない。**JSON の `exitCode` とプロセス Exit Code の一致は単一ソースで担保**（受入基準 3）
5. 結果ファイル書込失敗時: stderr へ理由を出し、Exit Code は実行結果のものを維持（結果は失われるが Exit は正。FlowNet 側が UNKNOWN 裁定 — 契約 §12「result 出力失敗」ケース）

## 5. KF-03: `capabilities` / `describe-profile` / `inspect-job`

新コマンド 3 つ（`src/commands/` へ。`COMMAND_FLAGS` / usage / spec 10 章の更新を含む）:

1. `ksql-flow capabilities --json` — ネットワーク・config 不要で即答（config 読めない環境でも互換性判定できることが目的）。Exit: 0 固定（引数エラーのみ 1）。出力は契約 §9.1 の形。値の正直さを厳守: `gracefulCancel` は KF-05 完了マイルストーンまで `false`、`durableExecutionStarted` は KF-04 完了まで `false`（変更点 §4「対応済みと偽らない」）。`jobLockProtocol` は現行形式を示す安定名 `"profile-job-v0"`（提案・返信文書へ記録。J1 移行時に `"J1"` へ）。**同梱 schema の配布 version（`$id` / contract version）を参照できるフィールドを含める**（裁定の補足 2 の要請）
2. `ksql-flow describe-profile --profile <p> --config <path> --json` — 解決済み profile 名・正規化した接続先 URL・guest space ID・timezone・論理アプリ名→app ID 対応・非秘密 limits（`maxApiCalls` / `maxReadRows` / `maxTempRows` / `batchTimeoutSec` / retry 設定 / `httpTimeoutMs`）・logApp のアプリ名と app ID。**token / password / basicAuth / 証明書 / Authorization を構造的に含めない**（フィールド allowlist 方式で実装し、denylist にしない）。Exit: 0 / config 不備 1
3. `ksql-flow inspect-job -f <sql> --profile <p> --config <path> --json` — `loadJobFile` の結果から: 論理 `jobId`（`job.name`）、`fileName`、文数、構文検証結果（engine diagnostics の code/severity/line/column）、**検出可能な非決定要素**。非決定要素はエンジン `parseScript` が返す診断（`@` なし時刻関数警告等）から列挙する — **エンジン申し送り文書で code を確認し、独自発明しない**。検出できない種類は「検出不能」を偽らない（静的検査は冪等性を証明しない — 契約 §9.3）。Exit: 検査完了 = 0（所見の有無に依らず）、ファイル・config 不備 = 1。検査 code の一覧は返信文書へ記録（D-23 の入力になる）

**canonical JSON（§13 決定・提案）**: `describe-profile` の出力は「キーを全階層で辞書順ソート・余分な空白なし・UTF-8・数値は JS 標準表現」（RFC 8785 相当の簡易規則）。規則を返信文書に明記し、テストで固定する。hash 計算は FlowNet 側の責務

## 6. 相関 ID のログ伝播とログアプリ template v0.4

1. ログアプリへ追加するフィールド（`LOG_APP_FIELDS` / `init-logapp` / `--check-logapp` / template v0.4）: `correlation_id`・`attempt_id`・`execution_id`（SINGLE_LINE_TEXT）、`job_id`（SINGLE_LINE_TEXT・論理ジョブ名）、`runner_execution_started_at`（DATETIME）。全て**非必須・重複禁止なし**（旧レコードは未設定のまま共存。受入基準 15 の rollback = フィールド削除で戻る）。**既存 `job_key` 系フィールドの制約（非必須・重複禁止）は変更しない**（裁定の補足 3。重複禁止 64 文字上限・必須+重複禁止の空文字 UPDATE 不可は devenxyfi 実測 CB_VA01）。相関 ID は最長 128 文字のため、非必須 SINGLE_LINE_TEXT が 128 文字を受理することを実機で確認してから template を確定する
2. 旧 schema 互換: `deletedCountSupport`（`src/logapp.ts:98`）を一般化し、`getFields` 1 回で存在するフィールドだけ送る方式へ（standalone は旧アプリで従来どおり動く）。**orchestrator モードは開始前に上記フィールドの存在を検査し、欠落なら SQL 開始前に fail-closed**（LOCK_UNAVAILABLE。耐久証跡が書けない環境で走らせない）
3. `status` DROP_DOWN へ `CANCELLED` 選択肢を追加（KF-05 用）。旧アプリで `CANCELLED` 書込みが 400 になる場合は既存の pending 退避（`finishRecord` の既存フォールバック）に乗せ、実行結果 JSON と Exit には影響させない
4. JSONL（`src/logging/jsonl.ts`）の全イベントへ orchestrator モード時 `correlationId` / `attemptId` / `executionId` を付与。JOB レコードにも同値を書く（受入基準 5: JOB ログ／JSONL から Node Attempt を追跡できる）
5. これらは監査相関専用。認証・ロックキー・冪等キーに使用しない（契約 §8）

## 7. KF-04: 耐久 `EXECUTION_STARTED`

orchestrator モードの `run` のみ。シーケンス（契約 §8.1）:

```text
acquireLock（既存 RUNNING 先行 INSERT、src/logapp.ts:146）
  ↓
（createExecutionContext まで既存どおり）
  ↓ 最初の executeStatement の直前
JOB レコードへ runner_execution_started_at（+相関 ID）を UPDATE し、成功応答を確認
  ↓ 確認 OK → JSONL へ execution_started イベント追記 → SQL 開始
  ↓ 確認 NG → SQL を開始せず fail-closed（結果 JSON: LOCK_UNAVAILABLE / executionStarted=false）
```

* **応答消失時の照会手順（§13 決定・提案）**: UPDATE の応答を確認できない場合、同レコードを再 GET（リトライ規則は既存 HTTP 層に従う）し、送信値と `runner_execution_started_at` を双方とも分単位へ正規化して一致した場合は「永続化成功」として SQL を開始してよい。対象レコードの同フィールドは当該ランナーだけが書くため、分精度一致で永続化確認として十分である。再 GET でも確認できなければ fail-closed。revision は kintone の楽観ロック（PUT の revision 指定）が engine `/flow` API 経由で使えるか確認し、使えなければ「自 batch_id のレコードへの再 GET 照合」で代替（エンジンへの機能依頼が必要なら文書起票し、返信文書に記録）。kintone DATETIME が分精度であることと本照合は実機検証済み（`m1_verification_record_20260830.md` 項目 4）
* `startedAt`（結果 JSON）はこの UPDATE の送信時刻を秒精度で維持する。JOB の `runner_execution_started_at` は kintone DATETIME の分精度で保存され、両者は分単位で一致する
* standalone（orchestrator フラグなし）の `run` は本シーケンスを行わない（従来どおり。余計な API 消費と旧 schema 非互換を避ける）

## 8. KF-05: signal / graceful cancel

1. orchestrator モード・standalone 共通で `run` に SIGINT / SIGTERM ハンドラを実装（`run-all` は本 M1 では対象外 — 契約 §1。既存挙動維持を回帰で確認）
2. cancel 境界（契約 §7。エンジン変更なしで実装可能な粒度）:
   * 文ループ（`src/executor.ts:233`）の次の文を開始しない
   * `onChunkWritten` callback（エンジンが await する — `executor.ts:203` コメント）で cancel フラグを検査し、次の書込 chunk を開始させない
   * 進行中の API request は完了を待つ（安全に中断できないため）
3. 停止後: 既存の `finishRecord` / JSONL / ロック解放を**結果確定 → 解放**の順で行い、`CANCELLED` 結果（status CANCELLED / resultCode CANCELLED / Exit 3）を出力。graceful cancel の Exit 3 は既存利用者互換に影響しない（現状 Ctrl+C は Node 既定の即死でコード未定義のため、契約化は追加であって変更ではない — §13 該当項目の決定として返信文書へ記録）
4. 2 回目の signal は即時終了（結果 JSON なし = FlowNet 側 UNKNOWN。forced kill 相当として文書化）
5. **Windows 差異**: Ctrl+C = SIGINT は Node で捕捉可能、SIGTERM は Windows へ配送されない、CTRL_BREAK = SIGBREAK も捕捉する。両 OS の contract test を用意（Windows はローカル実測、Unix は `linux_docker_verification_plan.md` の枠組み）。§13「Windows での Ctrl+C／CTRL_BREAK 処理」の決定内容を返信文書へ記録
6. `capabilities` の `gracefulCancel` は本マイルストーン完了とともに `true` へ

## 9. KF-06: Job lock recovery / force-unlock 契約（D-26）

既存 `unlock` / `--force-unlock`（profile 内全 RUNNING を対象、`src/commands/unlock.ts` / `run.ts:77`）は**人間向けとして不変更**。orchestrator 向けに機械可読・対象特定・停止確認必須の新コマンドを追加する:

1. `ksql-flow inspect-lock --job-key <key> --profile <p> --config <path> --json` — 読取専用。該当 job_key の RUNNING レコード（record id・batch_id・started_at・host・script_name）を返す。応答消失後の再照会にも使う
2. `ksql-flow force-unlock-job --job-key <key> --reason <text> --confirmed-by <name> --evidence-ref <uri> --profile <p> --config <path> --json` — 必須入力が 1 つでも欠けたら **API 呼び出し前に拒否**（Exit 1。FlowNet の Spike F と同じ fail-closed 順序）。認証主体は接続に使う token（profile）であり、`--confirmed-by` は停止を確認した人・仕組みの表示名
3. 停止確認は**入力**（kSQL-Flow が旧プロセスの停止を自ら証明できないため、確認済みであることの表明 + 証拠参照を要求し、解除レコードの `log_detail` へ全入力を記録する）。D-26 のとおり FlowNet は lock レコードを直接変更しない
4. 解除は既存 `recoverStale` 方式（終端 status + `job_key` クリア + `job_key_done` 退避の単一 UPDATE — D-26 追記の実測済み方式）を踏襲する。M1-g 実装判断は **既存選択肢 `FAILED` + `log_detail` 先頭の `LOCK_RECOVERY` 監査 JSON**。自動 stale 回収の `TIMEOUT` と判別でき、status 選択肢追加・旧ログアプリ移行を避ける
5. 結果 JSON（kind 例: `LOCK_RECOVERY_RESULT`、formatVersion 1）: 対象 job_key・record id・outcome（`RELEASED` / `NOT_FOUND` / `NOT_RUNNING` / `CONFLICT` / `UNCONFIRMED` 等の安定 code）・解除前後の状態。Exit（提案・返信文書へ記録): RELEASED=0 / 入力不備=1 / 照会不能・応答消失で未確定=3 / 対象が生きている競合=5
6. 応答消失時: 解除 UPDATE の応答を確認できなければ job_key と同一 record ID の監査内容を再 GET し、クリア済みかつ今回の `LOCK_RECOVERY` 監査と一致した場合だけ `RELEASED`。409 競合後に他者が解放して監査が一致しない場合は `NOT_RUNNING`、確認不能は `UNCONFIRMED`（Exit 3）とし、`inspect-lock` での再照会手順を結果 JSON と文書に明記

## 10. テストと受入基準の対応

* 契約 §12 の contract test のうち kSQL-Flow 側で担うもの: 正常系（SUCCESS/OK・NO_DATA・count 0・stdout/path 出力・ID 一致・executionStarted と耐久イベントの相関）、controlled failure 全 7 種、signal 系（SQL 開始前 Ctrl+C・read 中・write chunk 間・grace 超過 forced kill・stdout pipe 切断・result file 書込失敗）、Job lock recovery 6 種、互換性（既存 run-all Exit 回帰・additive unknown field を FlowNet が無視できる形）
* 「不正結果」系（JSON なし・破損・ID 不一致で UNKNOWN 化）と capability 不一致時の実行拒否は **FlowNet 側の受入**。kSQL-Flow 側は「不正結果を作らない」ことをテストする（exitCode 一致・executionStarted と resultCode の整合・count 非負整数を schema 検証で担保）
* 受入基準（変更点 §9）14 項目のうち kSQL-Flow 担当: 1〜6・9(expected-job-id)・10・11・13・14・15・16。7・8・9(describe-profile 照合/非決定要素承認)・12 は FlowNet 側
* 障害注入（Spike E の「マーカー成功後クラッシュ」「EXECUTION_STARTED 後クラッシュ」「応答消失」）用に、テスト専用の fault injection ポイント（例: 環境変数 `KSQL_FLOW_TEST_CRASH=<point>`。ビルドに残るが文書化された test-only 契約とする）を提案する — 採否はレビューで確定
* 実機検証: my-ksql-jobs と同一環境（devenxyfi.cybozu.com、実行ログ app 4249）。トークンは既存環境変数名を使い、値を文書・コードへ転記しない
* モックがエンジン実装と同じ仮定を共有する写経テストにしない（結合は `file:../kintone-sql-tools` 実体で）

## 11. 実装順（マイルストーン。各完了ごとに Claude Code レビュー）

| # | 内容 | 完了条件 |
| --- | --- | --- |
| M1-a | KF-01: 型・schema・変換表（裁定 Q13 反映済み・着手可） | fixture（sql-error.json 含む）+ 自作正常/失敗結果が schema 検証を通る |
| M1-b | KF-02: CLI 4 フラグ・stdout 規律・atomic 書込・controlled failure | stdout/path 両方で結果取得、全失敗経路で JSON と Exit が一致 |
| M1-c | 相関 ID ログ伝播 + template v0.4 + 旧 schema 互換 | JOB ログ/JSONL から attempt を追跡できる・旧アプリで退行なし |
| M1-d | KF-04: 耐久 EXECUTION_STARTED（実施順を KF-03 と入替え — M1-b/M1-c の run 経路変更に密結合のため先行） | 確認不能時に SQL 未開始で fail-closed（障害注入で実証） |
| M1-e | KF-03: capabilities / describe-profile / inspect-job | 3 コマンドの JSON が仕様どおり・秘密ゼロ・canonical 規則固定 |
| M1-f | KF-05: signal / cancel（両 OS） | 境界ごとの cancel テスト + Windows/Unix 実測記録 |
| M1-g | KF-06: inspect-lock / force-unlock-job | 停止確認なし拒否・応答消失 fail-closed・結果照合テスト |
| M1-h | 契約試験一式 + 回帰（run-all/dry-run/unlock）+ 返信文書材料 | 受入基準の kSQL-Flow 担当分が全て緑・実測記録あり |

## 12. 契約 §13 未決事項への決定（返信文書へ記録する一覧）

| §13 項目 | 実装確定値（M1-h） |
| --- | --- |
| result-json 上書き規則 | path の既存ファイルは API 呼出前に拒否。stdout は `-`。path は同一ディレクトリの一時ファイルを fsync 後 atomic rename |
| executionId 発行時点・形式 | `createRunnerEnv()` の既存 batchId（UUID v4）をプロセス起動時に発行し、executionId として共用 |
| graceful cancel の Exit 3 互換 | 単一 `run` の追加契約。1 回目は `CANCELLED` / Exit 3、2 回目は Exit 3 即時終了。signal 同時エラーも結果は CANCELLED、元メッセージは JSONL |
| EXECUTION_STARTED の revision・応答消失・照会 | RUNNING INSERT 直後の revision 1 を指定して UPDATE。応答消失は同一 record ID を再 GET し自値一致時だけ続行、確認不能は SQL 未開始で fail-closed |
| error code の最小安定集合 | category は `CONFIG / SQL / ASSERT / API / AUTH / TIMEOUT / LOCK / INTERNAL / CANCELLED`。既定 code は `VALIDATION_ERROR / SQL_ERROR / ASSERT_VIOLATION / EXECUTION_TIMEOUT / AUTH_ERROR / API_ERROR / LOCK_UNAVAILABLE / INTERNAL_ERROR / CANCELLED / LOCK_CONFLICT`、HTTP は `KINTONE_HTTP_<status>`、再試行枯渇は `RETRY_EXHAUSTED`、エンジン診断 code は原値を維持 |
| capability command の配置と Exit | トップレベル `capabilities --json`。config・通信不要、正常 Exit 0（引数不備のみ 1） |
| Windows Ctrl+C / CTRL_BREAK | Windows は SIGINT / SIGBREAK を捕捉。SIGTERM handler も登録するが Windows の通常 console 配送対象ではない。Unix は SIGINT / SIGTERM、SIGBREAK は登録しない |
| JSON Schema 配布 | `schema/execution-result-v1.schema.json` を正本として同梱。`$id` と `x-contract: ksql-flow.execution/v1` を capabilities から参照可能 |
| JOB ログ相関フィールド移行 | template v0.4 で相関 5 フィールドを非必須・非 unique 追加し `CANCELLED` 選択肢追加。standalone は旧 schema 互換、orchestrator は存在検査して欠落時 fail-closed |
| force-unlock の CLI・schema・Exit・照会 | `inspect-lock` と `force-unlock-job` を実装。後者は停止確認 3 入力必須、`LOCK_RECOVERY_RESULT` v1、`RELEASED/NOT_FOUND/NOT_RUNNING=0`、入力不備 1、`UNCONFIRMED=3`、`CONFLICT=5`。応答消失は job_key と同一 record の監査内容を再照合 |
| describe-profile canonical JSON | 全階層のキーを辞書順ソート、余分な空白なし、UTF-8、数値は JSON.stringify の JS 標準表現 |
| inspect-job 検査 code・例外 schema | 公開 code は `KSQL1001`〜`1006` / `1101` / `1201`〜`1203` / `1301`〜`1306`。非決定要素は `KSQL1306` のみ。通信なしのため schema 依存 `KSQL1302/1303` は検出不能。承認済み例外 manifest は FlowNet 側 |

## 13. 疑義の裁定結果（解決済み）

疑義 1（実行時 SQL エラーの Exit Code）は 2026-08-30 に**提案どおり承諾**され、FlowNet 正本（契約 §4.2/§12・変更点一覧 §3・schema・fixture）は ksql-flownet main `c95cbc4` で修正済み。確認 2 の解釈・予告 3 の 11 項目にも異議なし。詳細: `docs/kSQL-FlowNetからの返信-20260830-M1疑義裁定.md`、`docs/internal/reviews/decisions.md` Q13。**ブロッカーはなく、M1-a から着手できる。**

FlowNet からの補足 3 点（本文へ反映済み）:

1. result-json の attempt ごとの一意 path は FlowNet 側 executor adapter の責務（本リポジトリは §4-3 の上書き拒否のみ）
2. schema 正本は本リポジトリ同梱版。`$id` + contract version を含め、`capabilities --json` から配布 version を参照可能にする（§3・§5-1）
3. 既存 `job_key` 系の制約を変えない（§6-1）
