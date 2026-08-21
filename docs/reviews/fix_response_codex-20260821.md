# コードレビュー修正回答（Codex / 2026-08-21）

対象レビュー: `docs/reviews/code_review_codex-M1-M7-20260821.md`

## 指摘別の対応

### 指摘 1（BLOCKER）: `logApp` 未設定の fail-open

- 修正方法: `run` / `run-all` の実行経路で `logApp` を必須化した。未設定かつ `--lock local-only` なしは業務 API 呼び出し前に ConfigError 相当の Exit 1 で停止する。`--lock local-only` が明示された場合だけ警告を出して続行する。`--dry-run` は業務 DML と分散ロックを行わないため対象外。
- 変更ファイル: `src/commands/run.ts`, `src/commands/runAll.ts`, `README.md`
- 追加テスト: `logApp 未設定は既定で Exit 1・業務書込 0 件`, `logApp 未設定でも --lock local-only 明示時だけ警告付きで続行する`, `logApp 未設定は既定で Exit 1、--lock local-only 明示時だけ続行する`

### 指摘 2（BLOCKER）: 生存中プロセスの stale 誤回収

- 修正方法: 同一ホストの PID 生存確認が成功した場合は直ちに非 stale と判定し、`batchTimeoutSec` 超過だけでは回収しないようにした。PID が死亡している場合のみ stale とする。
- 変更ファイル: `src/lock.ts`
- 追加・更新テスト: `ローカルロックが残っていて相手プロセスが生存中なら Exit 5`（開始時刻を timeout 超過に変更）

### 指摘 3（BLOCKER）: force-unlock 後の所有権崩壊

- 修正方法: `LocalLock` が取得時の `batchId` を保持し、`release()` 時に現在のロックファイルの `batchId` と一致する場合だけ削除するようにした。旧所有者は新所有者のロックを削除しない。
- 変更ファイル: `src/lock.ts`
- 追加テスト: `force-unlock 後の旧所有者 release は新所有者のロックを削除しない`

### 指摘 4（BLOCKER）: notifications / proxy の未解決 `env:` を無言スキップ

- 修正方法: `notifications.onFailure.webhook`, `notifications.heartbeat.url`, `proxy` を共通の `resolveEnvRef()` で解決し、未定義または空の環境変数は ConfigError（Exit 1）に統一した。
- 変更ファイル: `src/config.ts`
- 追加テスト: `明記された未解決 env 参照は黙って無効化しない`（onFailure / heartbeat / proxy の 3 ケース）

### 指摘 5（MAJOR）: ロック INSERT の HTTP 400 誤分類

- 修正方法: INSERT が HTTP 400 の場合に `job_key` で再 GET する。競合 RUNNING レコードの存在を確認できた場合だけ `LockedError`（Exit 5）とし、存在しない一般 400 や確認不能は `LockUnavailableError`（Exit 3）として fail-closed にした。エンジンの `KintoneHttpError` が errors 詳細を保持しない制約に依存しない方式を採用した。
- 変更ファイル: `src/logapp.ts`
- 追加テスト: `ロック INSERT の一般的な HTTP 400 は多重起動でなく Exit 3`

### 指摘 6（MAJOR）: JOB レコード 0 件バッチの `--resume`

- 修正方法: ログアプリ由来の resume 選抜でも、直近 BATCH 配下の JOB レコードに現れない現行ジョブを未着手として selection に追加した。既存の state.json フォールバックと同じ扱いにした。
- 変更ファイル: `src/commands/runAll.ts`
- 追加テスト: `直近 BATCH に JOB レコードが 0 件なら全ジョブを未着手として再実行する`

### 指摘 8（MAJOR）: `clientCert` / `proxy` を受理して無視

- 修正方法: 設定ファイル読込時に、未対応であることと設定削除を案内する ConfigError（Exit 1）を返すようにした。手組みの `ResolvedProfile` からも迂回できないよう `createRunnerEnv()` にも防御を追加した。README の制限事項を fail-closed の説明へ更新した。
- 変更ファイル: `src/config.ts`, `src/runner.ts`, `README.md`
- 追加テスト: `未対応の接続設定 clientCert は ConfigError で停止する`, `未対応の接続設定 proxy は ConfigError で停止する`

### 指摘 9（MAJOR）: Webhook 非 2xx の無言成功

- 修正方法: Webhook POST の `response.ok` を確認し、非 2xx は URL・レスポンス本文を含まない HTTP status だけのエラーにした。既存の通知呼出し側で SecretMasker を通した警告を出し、ジョブ結果には影響させない。
- 変更ファイル: `src/notify.ts`
- 追加テスト: `Webhook 非 2xx はマスク済み警告を出しジョブ結果には影響しない`

### 指摘 10（MAJOR）: 境界値テスト不足

- 修正方法: `@rex0220/kintone-sql-tools/flow` の実エンジンとインメモリ kintone REST エミュレータを通る結合テストを追加した。0 / 1 / 100 / 101 件について業務アプリへの HTTP POST/PUT 回数が `ceil(N/100)` であることと JOB の `written_count` を検証する。文数は 20 文の成功と 21 文の Exit 1 を一組で検証する。
- 変更ファイル: `test/__tests__/run.test.ts`, `test/__tests__/validate.test.ts`
- 追加・更新テスト: `エンジン実体の書込境界 N 件: HTTP 書込回数 ceil(N/100) と written_count`（N = 0, 1, 100, 101）, `エンジン実体で 20 文ちょうどは成功・21 文は Exit 1`

## 裁定待ち項目

指摘 7（チェックポイント粒度 / `last_written_key` 縮退）、指摘 11（NO_DATA heartbeat）、指摘 12（TIMEOUT / SKIPPED の依存伝播）は変更していない。

## 検証結果

- `npm test`: 9 suites / 80 tests 成功
- `npm run build`: 成功

## fix2（裁定 Q1〜Q6 の反映）

### R1（裁定 Q2）: 依存伝播のホワイトリスト化

- 修正方法: 依存元の状態判定を `SUCCESS` / `NO_DATA` のホワイトリストへ変更し、それ以外の状態をすべて停止伝播させる形にした。従来挙動を維持しつつ、将来ステータスが追加された場合も依存先を安全側で `SKIPPED` にする。
- 変更ファイル: `src/commands/runAll.ts`, `test/__tests__/runAll.test.ts`
- 追加テスト: `LOCKED の依存元は SKIPPED となり依存先へ停止伝播する`, `TIMEOUT の依存元から依存先へ SKIPPED が伝播する`

### R2（裁定 Q4）: リトライ対象の追加

- 修正方法: 列挙方式を維持したまま `RETRYABLE_STATUS` に 504 / 522 / 524 を追加した。501 は対象外のままとした。
- 変更ファイル: `src/http.ts`, `test/__tests__/http.test.ts`
- 追加テスト: `HTTP 504 は一時エラーとしてリトライする`, `HTTP 522 は一時エラーとしてリトライする`, `HTTP 501 はリトライしない`

### R3（裁定 Q6）: filtered 記録と resume 選抜

- 修正方法: `--from` / `--only` の選抜外ジョブを、ロックを取得しない `insertRecord` 経由で `SKIPPED (filtered)` として記録するようにした。filtered は実行 outcome に加えないため、依存伝播・Exit 集約・onFailure 通知の対象にならない。ローカル state にも `skipReason: filtered` を保持し、state.json フォールバック時も同じ選抜規則にした。
- resume の判別手段と選択理由: `LogAppClient.listBatchJobs()` の取得フィールドへ既存の `log_detail` を追加し、`SKIPPED (filtered)` で始まるかを判定する方式を採用した。既存スキーマと既に記録している理由文字列をそのまま利用でき、ログアプリのフィールド追加・移行や `error_message` の意味変更が不要だからである。filtered は「記録済み」として未着手判定から除外する一方、`priorSuccess` には追加しない。これにより failure 起因の `SKIPPED` は再実行し、filtered は選抜外として依存を満たす現行経路を維持する。
- 変更ファイル: `src/commands/runAll.ts`, `src/logapp.ts`, `src/state.ts`, `test/__tests__/runAll.test.ts`, `README.md`
- 追加テスト: `--only は選抜外を SKIPPED (filtered) で記録し、直後の resume では再実行しない`, `filtered ジョブは onFailure 通知の失敗ジョブ一覧に含めない`

### R4（裁定 Q1 / Q3 / Q5）: README 反映

- 修正方法: heartbeat は `NO_DATA` を含む Exit 0 完了時に送信すること、kintone 標準通知の BATCH / 単発 JOB の 2 条件方式、`last_written_key` の `chunk:<n>` 形式は裁定 Q3 による期限付き容認で E-1 解消時に差し替えることを明記した。設計書リンクも v2.6 へ更新した。
- 変更ファイル: `README.md`
- コード変更・追加テスト: なし（Q1 / Q3 / Q5 の現実装は裁定どおり）

### fix2 検証結果

- `npm test`: 9 suites / 87 tests 成功（既存 80 件 + 追加 7 件）
- `npm run build`: 成功
- `../kintone-sql-tools`: コード変更なし（`git status` に既存の未追跡 `.claude/settings.local.json` があるが、本作業では変更していない）
- エンジン依存: `@rex0220/kintone-sql-tools/flow` のみを維持

## fix3（v3.70.0 対応・裁定 Q7 / Q3 縮退解除・E-2 回答）

### タスク A: v3.69.0 metrics 集計の判定と v3.70.0 対応

- **判定: (a) 正しかった。** 現行 fix2 の `src/executor.ts` は、`read_count` について各文の metrics 差分を保持せず、全文実行後に最後の `StatementResult.metrics.fetchedRows`（コンテキスト累積値）だけを読んでいた。v3.69.0 の同一ミュータブル参照は最後まで累積値を指すため、この読み方では合計取得件数が失われない。
- `written_count` は metrics を使わず、各 `StatementResult.result` の `insertedCount` / `updatedCount` / `deletedCount` を文ごとに合算していた。`api_calls` も metrics を使わず、ログ・ロックを含む `HttpLayer.snapshot()` のジョブ開始前後差分を使っていた。したがって、申し送りの「過去 metrics 参照との差分が 0」「末尾累積値の二重計上」のいずれにも該当しない。
- **過去ログへの影響範囲: なし。** fix2 の集計経路は共有参照の差分に依存していなかったため、v3.69.0 を使って作成した JOB の `read_count` / `written_count` / `api_calls` を本件理由で訂正する必要はない。
- v3.70.0 では累積 deep-copy スナップショット契約に合わせ、前文スナップショットとの差分から文単位 `readCount` / engine `apiCalls` を算出し JSONL の各 `statement` イベントへ記録する。JOB の `api_calls` は設計書 §7.2 の単一カウンタ要件に従い、引き続き HTTP 層の実測値を正とする。
- `written_count` は公開 API `isDmlResult` / `FlowDmlResult` へ移行し、INSERT / UPDATE / DELETE / UPSERT の discriminated union を `type` ごとに処理する。UPDATE に存在しない `insertedCount` は参照しない。
- 回帰テスト: 複数 SELECT の文単位増分 `[3, 1]` と合計 `read_count = 4`、各文の engine API 増分、UPDATE + INSERT の文単位 `writtenCount = [1, 1]` と合計 `written_count = 2` を実エンジンで検証した。このテストは v3.69.0 の共有参照を前回値として保持する実装へ戻すと、2 文目の差分が 0 になり検出できる。
- E-6 対応として `substituteAsOfFunctions` を撤去し、元の SQL と `asOf` / `timezone` を `explainScript` へ渡す形に変更した。README 互換表と `package-lock.json` の engine pin は v3.70.0 / dialect 1 / flow 0.1.x に更新した。

### タスク B: 設計書 v2.7 と裁定 Q7

- `docs/ksql_flow_design_v2_6.md` を基に `docs/ksql_flow_design_v2_7.md` を新規作成した。
- §5.1-2 からキー昇順書込・`last_written_key` の単調性・将来の途中再開前提を削除した。`last_written_key` を「最後に成功した書込チャンクの最終キー値（順序保証なし）」という障害調査用の診断情報へ再定義し、復旧は冪等リランを正とした。
- §8.2 を同じ定義へ更新し、単調な復旧ウォーターマークや途中再開位置として使用しないこと、キー値を取得できない操作はチャンク情報のみを残すことを明記した。
- 付録 C に v2.6 → v2.7 の Q7 / Q3 縮退解除表を追加した。`CLAUDE.md` / `AGENTS.md` の「仕様の正」を v2.7 へ、エンジン申し送り参照を v3.70.0 へ更新した。
- `docs/reviews/decisions.md` に Q7 として「エンジンへ整列追加を依頼しない」「順序保証なしの診断情報」「ウォーターマーク利用禁止」を記録した。

### タスク C: `onChunkWritten` と Q3 縮退解除

- HTTP 層の request payload 観測による `onWriteChunk` / `setWriteChunkHandler` を撤去し、`createExecutionContext({ onChunkWritten })` へ移行した。
- ローカル JSONL は成功した毎チャンクについて文 index、物理 app ID、操作、チャンク番号、処理件数、`lastKeyValue` を同期追記する。ログアプリ更新は従来どおり 25 チャンクまたは 60 秒の間引き時だけ await し、ジョブ終了時には最終成功チャンクの値を確定記録する。
- `lastKeyValue` がない操作では `chunk:<n>` を診断用フォールバックとして記録するが、順序・処理済み範囲・resume の判断には使用しない。
- UPSERT のキー列が `logging.maskFields` に含まれる場合は、JSONL・ログアプリの双方で `***` に伏字化する。既知秘密値の `SecretMasker` も重ねて適用する。
- 受入テスト: 250 件 UPSERT が `[100, 100, 50]` の 3 チャンクで発火し、最終 `C249` が JSONL とログアプリに残ること、3 チャンク目が失敗した場合は成功済み 200 件と `C199` が残ること、maskFields 指定時にキー値が伏字化されることを検証した。
- `docs/reviews/decisions.md` の Q3 に「縮退解除（2026-08-22 / v3.70.0 / fix3）」を追記し、間引きと JSONL 毎チャンク記録を維持しつつ Q7 の定義に従うことを明記した。

### タスク D: E-2 設計提案 R1 への回答

- ランナー側回答: `docs/kSQL FlowからのE2回答-R2依頼-20260822.md`
- エンジン宛て同内容: `C:/Users/rex02/Projects/kintone-sql-tools/docs/flow_e2_dryrun_reply_20260822.md`
- 5 問すべてに回答した。unchanged は初版不要、サンプル既定 5 / 上限 50、DELETE はキーサンプル必須、推定所要時間はランナー算出、単一 ExecutionContext で read-only 文を実行し DML のみ preview する方式を推奨した。
- R1 の「`Promise<PreviewResult>` だが非 DML は通常実行」という戻り値型の曖昧さには、`previewStatement` を DML 専用にする推奨案を提示した。見解が割れる場合は裁定者 Takashi に上げるが、回答自体は保留していない。
- エンジンリポジトリへの変更は、許可された上記回答文書 1 ファイルの新規追加だけであり、既存ファイル・コードは変更していない。

### fix3 検証結果

- テスト件数: **87 → 92**（追加 6 件、HTTP payload 観測の旧テスト 1 件を責務撤去に伴い削除、純増 5 件）
- `npm test -- --runInBand`: 9 suites / 92 tests 成功
- `npm run build`: 成功
- エンジン依存: `@rex0220/kintone-sql-tools/flow` の公開 API のみを維持（v3.70.0）

### fix3 差し戻し対応

- 修正方法: `maskLastKeyValue` で `UPSERT` に加えて `UPSERT_SELECT` もキー列の `logging.maskFields` 照合対象とし、両 AST タイプの `keyFields` を同じ伏字化経路へ通すようにした。
- 変更ファイル: `src/executor.ts`, `test/__tests__/run.test.ts`, `docs/reviews/fix_response_codex-20260821.md`
- 追加テスト: `UPSERT SELECT の lastKeyValue も logging.maskFields で伏字化する`

## fix4（v3.71.0 / dry-run 本実装）

### 実装内容

- `src/commands/dryrun.ts` を EXPLAIN 縮退版から差分プレビュー実装へ置換した。単一 `ExecutionContext` で read-only 文は `executeStatement`、DML は `previewStatement` に振り分け、TEMP TABLE・変数・as-of / timezone を共有する。
- ASSERT 違反は「ABORTED になる」表示 + Exit 2、EXIT SUCCESS IF 成立は直前の `executeStatement` の `EXIT_NO_DATA` で判定して「NO_DATA になる」表示 + Exit 0 とし、残りの文を打ち切る。
- INSERT / UPDATE / DELETE の予定件数、read-only / preview の実測 API 消費、before / after、DELETE キーサンプルを人間向け表示と JSON に写像した。`--sample` は 1〜50（既定 5）、`--json` は run で `DRY_RUN`、run-all で `DRY_RUN_BATCH` の単一オブジェクトを出力する。
- `logging.maskFields` は該当値を `***`、`logging.stripLiterals` 有効時はその他のサンプル値を `?` とし、コンソール・JSON・ローカル JSONL を同じマスク済み構造から生成する。
- HTTP 層へ dry-run ガードを追加した。record read 用 cursor の POST / DELETE だけを許可し、それ以外の kintone 変更系 POST / PUT / DELETE は下位 fetch 前に `DryRunMutationError` とする。dry-run 経路はロック、ログアプリ、state を通らず、ローカル JSONL とコンソールだけを更新する。
- `limits.maxApiCalls` / `--max-api-calls` は prepare、read-only、preview の共有 HTTP カウンタへ適用し、超過時は Exit 3 で安全停止して確定済みプレビューを保持する。
- `run-all --dry-run` は既存の依存検証済みファイル順で連続実行し、ロックを取得しない。人間向け表示の先頭および JSON の `warning` に「ジョブ間のデータ依存は再現されない」旨を載せる。

### 依存・テスト

- `package.json` のエンジン依存をレジストリ版 `^3.71.0` へ更新した。`package-lock.json` も v3.71.0 の npm tarball を固定し、ローカル開発時だけ `npm run dev:engine-local` で `file:../kintone-sql-tools` を一時適用する。
- テスト件数: **93 → 100**（受け入れ基準 1〜7 と HTTP ガードを追加し、旧 EXPLAIN 縮退テストを差し替えた結果、純増 7 件）。`npm test`: 9 suites / 100 tests 成功。`npm run build`: 成功。
- 実証内容: §3.1 サンプルの差分、mutation request 0、prepare 検証、ABORTED / Exit 2、NO_DATA / Exit 0、maskFields / stripLiterals、sample / JSON、maxApiCalls の部分表示、run-all の依存順・注意文・ロックなしを実エンジン v3.71.0 + mock kintone 結合テストで確認した。

### R2・裁定

- **R2 仕様との差異: なし。** counts 3 キー固定、サンプル既定 5 / 上限 50、DELETE キーのみ、reads / estimatedWrites、context 共有、書込 0 の6件をそのまま利用した。
- R2 外の v3.71.0 確定事項「EXIT 成立後の preview は全ゼロ」は認識済み。ランナーは契約どおり直前の `executeStatement` 結果で EXIT 成立を判定し、その場で打ち切るため後続 DML を呼び出さない。
- **新規裁定: なし。** run-all は指示書の明示案（依存順で継続し、非再現制約を冒頭表示）で判断が割れなかったため `docs/reviews/decisions.md` は変更していない。

### 設計書 v2.8・文書

- `docs/ksql_flow_design_v2_8.md` を新規作成し、§10.2 を実測差分プレビュー、HTTP 副作用ゼロ、ゲート Exit、マスキング、sample / JSON、maxApiCalls、run-all 制約で確定した。縮退版 / E-2 待ち注記は残していない。
- §12 に dry-run HTTP 多重防壁、§14 に `validate-all` + `run-all --dry-run --json` の CI 例、付録 C に v2.7 → v2.8 fix4 を追加した。
- `CLAUDE.md` / `AGENTS.md` の仕様の正を v2.8、エンジン申し送りを v3.71.0 へ更新した。README は dry-run 節、CI 例、互換表 v3.71.0、ローカルエンジン結合手順を更新した。

### エンジン宛て申し送り

- 本リポジトリ: `docs/kSQL Flowからの申し送り-fix4-dryrun完了-20260822.md`
- エンジンリポジトリ: `C:/Users/rex02/Projects/kintone-sql-tools/docs/flow_fix4_dryrun_completion_20260822.md`
- ① fix4 完了、② Q3 縮退解除済み、③ metrics 判定 (a) / Q7 の2件が fix3 でクローズ済みであることを1通にまとめた。エンジン側への追加はこの新規文書1ファイルだけで、コード・既存文書は変更していない。
