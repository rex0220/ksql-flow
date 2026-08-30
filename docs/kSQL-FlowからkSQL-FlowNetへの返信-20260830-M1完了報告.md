# kSQL-Flow から kSQL-FlowNet への返信: M1 完了報告

**状態: ドラフト（実機検証未了・オーナー承認待ち）**  
作成日: 2026-08-30 / 対象: Execution Contract v1 Phase 0（KF-01〜KF-06、M1-a〜M1-h）

## 1. 実装内容とコミット範囲

M1-a〜M1-g は実装・Claude Code レビュー通過・コミット済みである。コミット範囲は `6780fd9^..29fac48`（実装コミットは `6780fd9`〜`29fac48` の 7 件）。M1-h は本書作成時点で机上パートを実装・試験済みだが、未コミットである。

| マイルストーン | KF / 内容 | コミット・状態 |
| --- | --- | --- |
| M1-a | KF-01 Execution Result v1 型・正本 schema・変換表 | `6780fd9` |
| M1-b | KF-02 orchestrator 4 フラグ、stdout/path 出力、controlled failure | `10f2a3d` |
| M1-c | 相関 ID の JOB/JSONL 伝播、template v0.4、旧 schema 互換 | `7bdfef6` |
| M1-d | KF-04 耐久 `EXECUTION_STARTED`、revision 固定 UPDATE、再 GET 照合 | `b034d38` |
| M1-e | KF-03 `capabilities` / `describe-profile` / `inspect-job` | `f58846a` |
| M1-f | KF-05 graceful cancel、境界停止、forced termination | `1a3ef63` |
| M1-g | KF-06 `inspect-lock` / `force-unlock-job` | `29fac48` |
| M1-h | レビュー指摘 3 件、EPIPE/additive field/回帰試験、README/CHANGELOG/本報告 | 未コミット（机上完了） |

M1-h では次を追加確定した。

- 409 競合後に `job_key` が消えている場合、同一 record ID の `job_key_done` と `log_detail` が今回の監査内容に一致するときだけ `RELEASED` とする。他者解放で監査が一致しない場合は `NOT_RUNNING`（Exit 0）とする。`auditRecorded` の schema 追加案は採用しなかった。
- `listRunning` の取得 fields に `$revision` / `host` / `script_name` を追加した。
- signal と真のエラーが同時発生した場合、Execution Result は `CANCELLED` を優先し、マスク対象の元メッセージと cause chain を JSONL `cancelled_with_error` に残す。
- stdout が EPIPE でも path 出力は stdout に触れないこと、stdout writer の例外を検知して実行本来の Exit を維持すること、additive unknown field を同梱 schema の FlowNet 相当検証が受理することを試験した。既存 `run-all` Exit 0〜5・優先順位・resume 回帰は既存試験で確認した。

## 2. 契約 §13 の確定事項

| 項目 | 実装確定値 |
| --- | --- |
| result-json 上書き | path の既存ファイルは API 呼出前に拒否。path は同一ディレクトリの一時ファイルへ書込・fsync 後 atomic rename。`-` は stdout |
| executionId | 既存 batchId（UUID v4）と同値。`createRunnerEnv()` によりプロセス起動時、ロック取得前に発行 |
| ID 不正 | 4 ID/出力フラグの全か無か違反、文字種・長さ違反では、入力値の echo によるログ注入を避けるため結果 JSON を出力しない |
| graceful cancel | 単一 `run` で 1 回目 signal は安全境界まで待ち `CANCELLED` / Exit 3。2 回目は Exit 3 即時終了で結果 JSON 非保証。既存挙動への追加契約 |
| signal 同時エラー | 結果 JSON は `CANCELLED` 優先。元エラーは SecretMasker 適用対象の JSONL `cancelled_with_error` に記録 |
| `EXECUTION_STARTED` | RUNNING INSERT 直後の expected revision 1 を指定。UPDATE 応答消失は同一 record ID を再 GET し、送信値と `runner_execution_started_at` を双方とも分単位へ正規化して一致した場合のみ SQL 開始。kintone DATETIME は分精度、結果 `startedAt` は秒精度を維持する。確認不能は SQL 未開始で fail-closed。実機検証で確認済み（`docs/internal/m1_verification_record_20260830.md` 項目 4） |
| error category | `CONFIG / SQL / ASSERT / API / AUTH / TIMEOUT / LOCK / INTERNAL / CANCELLED` の 9 値から開始。additive 互換 |
| error code | 既定は `VALIDATION_ERROR / SQL_ERROR / ASSERT_VIOLATION / EXECUTION_TIMEOUT / AUTH_ERROR / API_ERROR / LOCK_UNAVAILABLE / INTERNAL_ERROR / CANCELLED / LOCK_CONFLICT`。HTTP は `KINTONE_HTTP_<status>`、再試行枯渇は `RETRY_EXHAUSTED`。エンジン診断 code は原値を維持 |
| capabilities | トップレベル `ksql-flow capabilities --json`。config・通信不要、正常 Exit 0（引数不備 1）。`resultSchema.$id` と contract を公開 |
| OS signal 差 | Unix は SIGINT / SIGTERM。Windows は Ctrl+C の SIGINT と Ctrl+Break の SIGBREAK。SIGTERM handler も登録するが Windows console の通常配送対象ではない |
| canonical JSON | `describe-profile` は全階層のキーを辞書順ソート、余分な空白なし、UTF-8、数値は `JSON.stringify` の JS 標準表現。hash 計算は FlowNet 責務 |
| schema 配布 | `schema/execution-result-v1.schema.json` を kSQL-Flow 側正本として同梱。`$id` は `https://github.com/rex0220/ksql-flow/blob/main/schema/execution-result-v1.schema.json`、contract は `ksql-flow.execution/v1` |
| JOB 相関移行 | template v0.4 で `correlation_id / attempt_id / execution_id / job_id / runner_execution_started_at` を非必須・非 unique 追加し、status に `CANCELLED` を追加。standalone は旧 schema と共存、orchestrator は開始前存在検査で fail-closed。既存アプリへの適用は同梱の `scripts/logapp_v04_upgrade.console.js`（ブラウザ Console 実行。レイアウト配置と確認用一覧「FlowNet相関確認」の作成まで自動・冪等）。適用後は `scripts/logapp_v04_field_acl.console.js` で相関 5 フィールドを Everyone=閲覧のみ にすることを推奨（監査・耐久証跡の人為改変防止。API トークンは Administrator 相当で対象外のためランナー書込は不変） |
| force-unlock | 下記 2 コマンドと machine-readable schema/Exit を確定。FlowNet はログレコードを直接変更しない |
| inspect-job | エンジン公開診断 code を無改変で返す。非決定要素は現在 `KSQL1306` のみ。承認済み例外 manifest は FlowNet 責務 |

正本 schema は producer である kSQL-Flow の安全制約として契約本文より厳格である。具体的には、(a) `lastSuccessfulChunkNo` / `lastWrittenKey` を required、(b) `executionStarted=false` の count 類を 0、(c) `LOCK_UNAVAILABLE` も `executionStarted=false`、(d) 既知 resultCode ごとの error.category を固定する。一方、root と error 内の未知フィールド、未知 resultCode/category は整合条件の範囲で additive に受理する。

耐久マーカーと結果の優先関係も確定する。`runner_execution_started_at` は「SQL 開始直前まで到達した」耐久証跡である。PUT 成功後に応答と再 GET の両方を失った場合、マーカーが残っていてもランナーは SQL を開始せず、有効な Execution Result が存在するならその `executionStarted=false` を正とする。結果 JSON がない場合の UNKNOWN 裁定は FlowNet 責務である。

## 3. force-unlock 2 コマンドの契約

### `inspect-lock`

入力は `--job-key / --profile / --config / --json`。出力は `kind: LOCK_INSPECTION_RESULT`、`formatVersion: 1`、`jobKey`、`locked`、`record`（`recordId / batchId / startedAt / host / scriptName`）、`inspectedAt`。RUNNING 有無の照会成功は Exit 0、入力・config 不備は 1、照会不能は `locked: null`・`LOCK_QUERY_UNAVAILABLE`・Exit 3。

### `force-unlock-job`

入力は上記に `--reason / --confirmed-by / --evidence-ref` を加え、3 つの停止確認入力は API 呼出前の必須検査とする。解除は検索時 identity を record ID GET で再確認し、その revision を指定した 1 回の UPDATE で `status=FAILED`、`job_key` クリア、`job_key_done` 退避、`finished_at`、`LOCK_RECOVERY` 監査 JSON を同時記録する。

出力は `kind: LOCK_RECOVERY_RESULT`、`formatVersion: 1`、`jobKey / recordId / outcome / before(batchId, startedAt, host) / executedAt`、必要時 `nextAction`。Exit は `RELEASED / NOT_FOUND / NOT_RUNNING = 0`、入力不備 1、`UNCONFIRMED = 3`、`CONFLICT = 5`。応答消失後は job_key だけでなく同一 record ID の監査内容まで一致した場合だけ `RELEASED` とする。

## 4. D-22 / D-23 / D-26 クローズ審議材料

### D-22: 耐久 `EXECUTION_STARTED`

- revision 1 付き UPDATE 成功確認 → JSONL `execution_started` → 最初の SQL 文、の順序をリクエスト列で試験済み。
- kintone DATETIME は分精度のため、JOB 値は分精度、Execution Result `startedAt` と JSONL 時刻は秒精度を維持し、三者は分単位で一致する。実機検証で確認済み（`docs/internal/m1_verification_record_20260830.md` 項目 4）。
- UPDATE 失敗時はデータ API 0 件、`LOCK_UNAVAILABLE` / Exit 3 / `executionStarted=false`、ロック解放を試験済み。
- PUT 応答消失後の再 GET 一致なら続行、不一致・照会不能なら SQL 未実行で fail-closed の両分岐を試験済み。
- 実 kintone E2E は実施済み（`docs/internal/m1_verification_record_20260830.md` 項目 4）。プロセス実 signal/kill は未実施のため、本ドラフトだけで D-22 を最終クローズしない。

### D-23: inspect-job と静的検出限界

エンジン v3.74.0 の公開診断 code は `KSQL1001`〜`KSQL1006`、`KSQL1101`、`KSQL1201`〜`KSQL1203`、`KSQL1301`〜`KSQL1306`。`inspect-job` はこれを code/severity/line/column/message として返す。

- 非決定要素へ分類する code は `KSQL1306`（`@` なし時刻関数）のみ。
- `KSQL1305`（素の INSERT）は冪等性警告として diagnostics に含むが、非決定要素には分類しない。
- `KSQL1302`（update key field type）/ `KSQL1303`（unique 制約）は app schema 依存であり、通信なし `inspect-job` では検出不能。実 client を使う `validate` の責務である。
- 乱数・外部状態参照に対応する公開診断 code はなく、静的検査で冪等性を証明しない。未検出を検出済みとして扱わない。

FlowNet 側には、job ID / describe-profile 照合、`KSQL1306` 例外承認、上記の検出限界を踏まえた manifest 運用が残る。

### D-26: force-unlock 所有境界

対象限定の 2 コマンド、停止確認必須入力、revision 固定単一 UPDATE、監査、安定 outcome/Exit、応答消失後の再照会、409 後の他者解放 `NOT_RUNNING` 分類まで机上試験済み。FlowNet は lock レコードを直接変更せず、この結果を Network 監査へ関連付ける。実 kintone E2E は未実施のため、本ドラフトだけで最終クローズしない。

## 5. Phase 0 受入基準の充足状況

依頼文では「14 項目」とされているが、2026-08-30 時点の FlowNet 正本 `current-ksql-flow-changes.md` §9 は追加項目を含む 16 項目である。欠落を避けるため現行 16 項目を全て評価する。

| # | 受入基準 | 区分 | 状況 |
| ---: | --- | --- | --- |
| 1 | result stdout に JSON 以外を混入しない | kSQL-Flow | 机上完了。1 object + LF、BOM/ANSI/人間向け出力なしを試験 |
| 2 | path で途中 JSON を完成結果として観測しない | kSQL-Flow | 机上完了。same-dir temp、fsync、atomic rename、既存拒否、EPIPE 非干渉を試験 |
| 3 | JSON Exit とプロセス Exit の一致 | kSQL-Flow | 机上完了。controlled failure と出力失敗時の本来 Exit 維持を試験 |
| 4 | correlationId / attemptId が入力と一致 | kSQL-Flow | 机上完了。128 文字値の実ログアプリ受理は実機待ち |
| 5 | JOB / JSONL から Node Attempt を追跡可能 | kSQL-Flow | 机上完了。template v0.4 の実ログアプリ適用は完了（`docs/internal/m1_verification_record_20260830.md` 項目 1）。実 kintone での相関記録 E2E は実機待ち |
| 6 | SUCCESS / NO_DATA / ASSERT / timeout / API / lock を安定分類 | kSQL-Flow | 机上完了。controlled failure 全経路と schema 整合を試験 |
| 7 | JSON なし・破損・ID/Exit 不一致を UNKNOWN | FlowNet | FlowNet 責務。kSQL-Flow は不正結果を生成しない schema 試験済み |
| 8 | capability 不一致で SQL 未実行 | FlowNet | FlowNet 責務。kSQL-Flow は capabilities の正直な値を机上確認済み |
| 9 | profile/job ID/非決定要素の事前照合 | 分担 | expected-job-id 拒否は kSQL-Flow 机上完了。describe-profile 照合と例外承認は FlowNet 責務 |
| 10 | node_id と job_id が異なっても同じ Job lock | 分担 | kSQL-Flow は照合済み論理 job ID から既存 `{profile}:{job_id}` を生成。FlowNet の node/job 分離結合は FlowNet 責務 |
| 11 | `EXECUTION_STARTED` 未確認なら SQL 未開始 | kSQL-Flow | 机上完了。失敗・応答消失分岐を試験。実 kintone E2E 待ち |
| 12 | executionStarted/resultCode 矛盾を拒否 | FlowNet | FlowNet の不正結果受入責務。kSQL-Flow 正本 schema は矛盾を拒否済み |
| 13 | 既存 run-all Exit / resume 非退行 | kSQL-Flow | 机上完了。Exit 0〜5、優先順位、resume の既存試験を維持 |
| 14 | Windows / Unix signal・forced kill | kSQL-Flow | **実機待ち**。process.emit による全境界試験のみ完了 |
| 15 | 相関フィールドが旧 schema/record と共存・rollback可能 | kSQL-Flow | 旧 schema standalone と orchestrator fail-closed は机上完了。**実ログアプリへの v0.4 適用・既存レコード共存は実機確認済み（2026-08-30、検証記録 項目 1）**。128 文字 ID と rollback 実削除は実機待ち |
| 16 | force-unlock が停止確認なし拒否・結果照合可能 | 分担 | kSQL-Flow 机上完了。FlowNet 監査関連付けと実 kintone E2E は未了 |

## 6. 未了の実機検証（TBD）

1. ~~template v0.4 の実ログアプリ適用~~ — **完了（2026-08-30）**。`scripts/logapp_v04_upgrade.console.js` により相関 5 フィールド・`CANCELLED` 選択肢・レイアウト・確認用一覧を適用し、本番フォーム検証まで合格（`docs/internal/m1_verification_record_20260830.md` 項目 1）。rollback の実削除試行のみ任意の残項目。
2. 相関 ID 5 フィールドで 128 文字 ID が保存・再 GET できることの確認（認証値は記録しない）。
3. Windows 実 console の Ctrl+C / Ctrl+Break と forced termination、Unix の SIGINT / SIGTERM と 2 回目 signal を実プロセスで確認。
4. 実 kintone で orchestrator 単一 run、耐久 `EXECUTION_STARTED`、応答消失相当、結果 path、`inspect-lock` / `force-unlock-job` の E2E を確認。

以上の実機記録とオーナー承認を得るまで、本書と Execution Contract v1 の状態はドラフトのままとする。
