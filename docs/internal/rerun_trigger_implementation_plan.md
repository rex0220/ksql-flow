# kintone リラン指示ポーラー実装計画

* 作成: 2026-08-27（Codex）／**Q12 改訂: 2026-08-27**（`rerun_trigger_design.md` v7・Q12 のチェックボックス分離を反映）
* 対象: kSQL Flow v0.4.0 を利用する VPS / オンプレのジョブリポジトリ
* 状態: **第 1 段階完了（実機ドリル 13/14 合格・2026-08-27）** — 記録は `poll_control_drill_record-20260827.md`。14/14 完了
* 正: `rerun_trigger_design.md` **v7 のみ**。`reviews/decisions.md` Q8・Q9・Q10・Q11（追補 1〜3 を含む）・Q12 はすべて裁定済みであり、本計画では再提案しない
* 関連: `ksql_flow_spec.md` §5.5・§6・§8・§10.3、`reviews/poll_control_plan_review_claudecode-20260827.md`

---

## 1. 目的と固定条件

既存の kintone 実行ログアプリを VPS から定期ポーリングし、失敗した BATCH レコードのチェックボックス `rerun_request`（選択肢 `REQUEST` 1 つ）に人間がチェックを入れたとき、SSH で行う場合と同じ固定コマンド `./run_batch.sh --resume` を起動する。専用の実行指示アプリは作らない。人間が編集するのは `rerun_request` だけで、`rerun_state` と結果フィールドはポーラー専用とする。要求、確保、実行結果は元の失敗 BATCH レコードの `rerun_` フィールドへ記録する。

変えるのは起動手段だけである。リラン対象の選抜、元バッチの as-of 引き継ぎ、分散ロック、JOB / BATCH ログ記録は公開済みの kSQL Flow v0.4.0 に委ねる。

MVP の固定条件は次のとおりとする。

* 操作はリランだけとし、通常実行とバックフィルは受け付けない
* 単一ホスト構成、「重複は受け入れ・不確定は人間に返す」意味論（設計 §4.2 v7.1）、ホスト単位の `flock`、要求の有効期限を採用する
* kSQL Flow 本体と `../kintone-sql-tools` は変更しない
* 対象バッチ固定、`git_ref` 一致による停止、新しい resume 選抜規則は導入しない
* API トークンは既存ログアプリ用の環境変数を再利用し、新しいトークンを増やさない
* 実ドメインとトークンはコミットしない。例示は `https://example.cybozu.com` と環境変数名だけにする
* 実 kintone での検証データは、識別可能な値をすべて `KSQL_FLOW_TEST_` で始める
* **`rerun_request` にチェックがある = まだ終端に至っていない要求**を不変条件とする。終端では必ずチェックを外し、Exit 5 の継続だけはチェックを残して `rerun_state = REQUESTED` とする

## 2. 成果物の配置

### 2.1 第 1 段階の配置

第 1 段階の成果物は kSQL Flow 本体ではなく、利用者のジョブリポジトリ `my-ksql-jobs` に置く。実績確認後に再利用用の `ksql-flow-template` へ反映する。

```text
my-ksql-jobs/
├── .env                              # 既存。秘密値、chmod 600、Git 管理外
├── jobs/
├── ksql.config.json                  # 既存。変更しない
├── poll-control.config.json          # 新規。ポーラー専用、秘密値なし
├── run_batch.sh                      # 既存。変更しない
├── scripts/
│   ├── poll_control.sh               # flock と Node 起動だけを担う薄いランチャー
│   └── poll_control.mjs              # REST API・状態遷移・子プロセス起動の本体
└── test/
    └── poll_control.test.mjs         # node:test によるローカル試験
```

この配置にする理由は次のとおりである。

* `run_batch.sh` の絶対パス、ホスト名、profile、cron、ログアプリ ID は配備先固有であり、ジョブと同じ変更管理単位に置くのが自然である
* kSQL Flow 本体へ入れると CLI 契約、公開 JSON Schema、配布物、互換性保証が新たに発生する
* `run_batch.sh --resume` をそのまま呼ぶことで、Q10 の「手動リランと同一動作」を構造的に守れる
* allowlist と実際の配備先を同じ PR でレビューできる

### 2.2 第 2 段階への移管

**テンプレート反映済み（2026-08-27）**: VPS 実機ドリル 14 本の通過をもって、スクリプト・設定 example・テスト 55 本・導入手順書を `ksql-flow-template` へ同梱した。反映時に「新規ユーザーの導入」を模擬した再テスト 6 項目（配布物のバイト同一性・新規 clone でテスト 55 本・example からの設定作成・実 kintone への `--check`・実ポーリング 1 回・実行ビット 100755）を VPS で通過。README には運用実績が浅い旨を明記。テンプレート ZIP への 10 フィールド反映は ksql-flow v0.4.1 で実施済み。kSQL Flow npm パッケージへの公式サブコマンド化と公開 Schema の追加は引き続き第 2 段階で扱う。

## 3. 実装言語と実行方式

REST API と状態遷移の本体は、依存パッケージを追加しない ESM の Node 22 スクリプトとする。VPS に Node 22 はあるが `jq` は保証されないため、shell + `curl` + `jq` は採用しない。

Node 本体は標準 `fetch`、`AbortSignal.timeout`、`child_process.spawn`、`URL`、JSON API だけを使う。子プロセスは固定 command と固定 args を `spawn(command, args, { cwd, shell: false })` で起動する。`sh -c`、文字列 command、レコード値の文字列補間は禁止する。

`flock` は Node 標準 APIにないため、`poll_control.sh` が固定絶対パスのロックファイルを使って `/usr/bin/flock -n` を取得し、固定絶対パスの Node 本体を `exec` する。取得失敗は「別ポーラーが動作中」の正常スキップとして、kintone API を呼ばず Exit 0 とする。Node から `curl`、`git`、別 shell は起動しない。

## 4. 実行ログアプリの拡張

### 4.1 追加する 10 フィールド

仕様 §8.2 および `src/logapp.ts` の既存 23 フィールドは変更しない。既存の実行ログアプリへ次の 10 フィールドを追加し、合計 33 フィールドとする。フィールドコードは小文字スネークケース、ラベルは日本語とし、BATCH レコードでだけ使用する。JOB レコードでは未選択または空欄のままとする。**10 フィールドは kintone 実機へ追加・デプロイ・検証済みである。**

| フィールドコード | ラベル | kintone 型 | 必須・既定 | 用途 |
| --- | --- | --- | --- | --- |
| `rerun_request` | リラン要求 | チェックボックス | 必須にしない・選択肢 `REQUEST` 1 つ・既定はチェックなし | **人間が編集する唯一のフィールド**。チェックありは未終端の要求を表す |
| `rerun_state` | リラン状態 | ドロップダウン | 必須にしない・**既定は未選択** | ポーラー専用の状態。選択肢は §4.2 |
| `rerun_requested_at` | リラン要求日時 | 日時 | 任意・空欄 | 新規要求・再要求の claim 時に人間の要求時刻を退避。有効期限の唯一の基準 |
| `rerun_requested_by` | リラン要求者 | 文字列（1行） | 任意・空欄 | 新規要求・再要求の claim 時に `更新者.code` を退避する恒久的な証跡 |
| `rerun_claimed_host` | リラン確保ホスト | 文字列（1行） | 任意・空欄 | claim したローカルホスト |
| `rerun_claim_expires_at` | リラン確保期限 | 日時 | 任意・空欄 | stale 回収の判定時刻 |
| `rerun_attempt` | リラン試行回数 | 数値 | 任意・初期値 0、整数、最小 0 | claim 成功回数。Exit 5 後も保持 |
| `rerun_exit_code` | リラン終了コード | 数値 | 任意・空欄、整数 | kSQL Flow の Exit Code |
| `rerun_result` | リラン結果 | 文字列（複数行） | 任意・空欄 | allowlist から選ぶ固定要約だけを格納 |
| `rerun_batch_id` | リラン実行バッチID | 文字列（1行） | 任意・空欄 | resume が新しく作った BATCH の `batch_id`。確定規則は §6.6 |

`rerun_state` に「空」という選択肢は作らない。通常の BATCH / JOB レコードにおける値なしは、kintone クエリでは `rerun_state in ("")` と表現する。

詳細画面では 10 フィールドを折りたたみグループへまとめる。一覧には失敗 BATCH の `status`、`profile`、`host`、`started_at`、`rerun_request`、`rerun_state`、`rerun_requested_at`、`rerun_requested_by`、`rerun_result`、`rerun_batch_id` を表示し、元の失敗とリラン結果を同一レコードで確認できるようにする。

### 4.2 `rerun_state` の選択肢と状態機械

選択肢は既存 `status` / `record_type` と同じ大文字 ASCII 識別子とする。

| 値 | 意味 | 設定主体 |
| --- | --- | --- |
| （未選択） | 未処理。新規要求はこの状態で `rerun_request` にチェックが入る | 既定 |
| `REQUESTED` | Exit 5 からの継続要求 | ポーラー |
| `CLAIMED` | ポーラーが確保し、実行中 | ポーラー |
| `SUCCESS` | Exit 0 で正常終了 | ポーラー |
| `FAILED` | Exit 1 / 2 / 3 / 4 で終了 | ポーラー |
| `UNKNOWN` | 結果を断定できない、または stale | ポーラー |
| `EXPIRED` | 有効期限超過のため未実行 | ポーラー |
| `CANCELED` | 受付条件を満たさず取消 | ポーラー |

```text
未選択 + チェックあり --新規要求を claim-----------> CLAIMED + チェック維持
REQUESTED + チェックあり --Exit 5 継続を再 claim----> CLAIMED + チェック維持
終端値 + チェックあり --再要求を初期化して claim---> CLAIMED + チェック維持
CLAIMED --Exit 5------------------------------------> REQUESTED + チェック維持
CLAIMED --Exit 0------------------------------------> SUCCESS + チェック解除
CLAIMED --Exit 1 / 2 / 3 / 4------------------------> FAILED + チェック解除
CLAIMED --signal / 未知 Exit------------------------> UNKNOWN + チェック解除
CLAIMED --確保期限超過------------------------------> UNKNOWN + チェック解除
候補 --期限超過-------------------------------------> EXPIRED + チェック解除
候補 --受付条件外-----------------------------------> CANCELED + チェック解除
```

`SUCCESS` / `FAILED` は既存 `status` と意味も一致するため再利用する。実行中は `status = RUNNING` との混同を避け、`rerun_claimed_host` / `rerun_claim_expires_at` と揃えて `CLAIMED` とする。`REQUESTED` は人間の入力値ではなく Exit 5 継続のマーカーである。stale は `UNKNOWN` へ更新してチェックを外し、自動再実行しない。終端値のまま人間がチェックを入れ直した場合は再要求として扱う。

### 4.3 フィールド追加と契約検査

アプリ管理者による 10 フィールドの追加とデプロイは実施済みである。`rerun_request` は選択肢 `REQUEST` 1 つ、既定はチェックなしとし、`rerun_state` は必須にせず上記 7 選択肢だけを設定している。既存レコードへの初期値の一括投入は行っていない。

既存の `init-logapp` は `LOG_APP_FIELDS` の 23 フィールドしか作らず、既存の `--check-logapp` は余分なフィールドを拒否しない代わりに `rerun_*` の不足も検出しない。ランナーは変更しないため、ポーラーが自前の `check` を持つ。

自前 check はポーラーの導入時および cron 有効化前の必須 preflight とし、`GET /k/v1/app/form/fields.json` で次を検査する。

* 10 フィールドがすべて存在する
* 型が §4.1 と一致する
* `rerun_request` の選択肢集合が `REQUEST` 1 つと完全一致し、既定がチェックなしである
* `rerun_state` の選択肢集合が §4.2 と完全一致する
* `rerun_state` が必須でなく、既定値が未選択である
* `rerun_attempt` が数値である

不一致時は候補取得と子プロセス起動を行わず fail-closed で停止する。通常ポーリングの固定費 288 回/日とは別に、導入・設定変更時の preflight API が発生する。cron の各回でフィールド定義 GET を重ねて固定費を 2 倍にしない。通常候補 GET で未知フィールドエラーが返った場合も fail-closed とし、運用者へ自前 check の再実行を促す。

### 4.4 アクセス権の設定手順

専用アプリは作らず、既存ログアプリのアクセス権を次の順で設定する。

1. アプリ管理者が §4.1 の 10 フィールドと一覧を追加し、アプリ設定をデプロイする。**実機では実施済み**である。
2. リラン依頼者グループにはアプリのレコード閲覧権限を与える。既存ログレコードの追加・削除権限は与えない。
3. フィールド単位アクセス権で、`rerun_request` だけをジョブ管理グループが編集可とし、`rerun_state` を含む**その他の全編集可能フィールドは Everyone = 閲覧のみ**とする。実機ではこの設定をデプロイ・検証済みであり、「`rerun_request` にチェックを入れられる人 = リランを起こせる人」となる。
4. 通知受信だけの実ユーザーには閲覧のみを与える。
5. 誤要求の `CANCELED` 化と状態更新はポーラーが行う。人間に `rerun_state` を編集させない。
6. VPS では既存ログアプリ用 API トークンの環境変数を再利用する。API トークンにはレコード閲覧・編集、およびランナーが必要とする追加権限が必要である。値は `.env` に保存して `chmod 600`、Git 管理外とする。
7. 実ユーザー、通知受信者、運用管理者、API トークンの各主体で許可・拒否を実測する。
8. リマインダーの条件通知を、タイミング「`更新日時` + 1 時間」、発報時再評価条件「`rerun_request` が `REQUEST` を含む、かつ `rerun_state` が未選択」で設定する。`REQUESTED` は含めない。**実機設定済み**である。

**API トークンは Administrator 相当で動作し、フィールド単位アクセス権の対象外である。** したがってトークンを `rerun_*` だけに制限することはできない。一方、フィールド単位アクセス権は実ユーザーには効くため、要求者の制御は維持できる。この非対称性を権限試験で明示的に確認する。

トークン操作後の `更新者` は Administrator になる。そのため新規要求と再要求の claim で、ポーラーがその要求についてまだ対象レコードを更新していない時点の `更新日時` と `更新者` を、それぞれ `rerun_requested_at` と `rerun_requested_by` に退避する。Exit 5 からの再 claim ではこの 2 フィールドを書き換えない。

## 5. 設定

### 5.1 保存先

ポーラー設定はトップレベルの `poll-control.config.json` に分離する。既存 `schema/ksql.config.schema.json` はトップレベルも profile も `additionalProperties: false` で未知キーを拒否するため、`ksql.config.json` に追加すると v0.4.0 の起動を壊す。ランナーを変更しない条件からも別ファイルが必要である。

秘密値は JSON に直接書かず、既存 `.env` の環境変数名だけを保持する。

### 5.2 設定項目

| 設定 | 例 / 既定 | 用途 |
| --- | --- | --- |
| kintone ベース URL | `https://example.cybozu.com` | API URL の固定基点。HTTPS 必須 |
| ゲストスペース ID | `null` | API パスの固定分岐 |
| ログアプリ ID | 数値 | 候補取得、claim、結果更新、BATCH 照合に共用 |
| ログアプリ token 環境変数名 | `KSQL_TOKEN_LOGS` | 既存ランナー用秘密値を再利用 |
| ローカル profile | `prod` | クエリ条件。レコード値から決めない |
| ローカル host | `vps-batch-01` | クエリ条件。ランナーが記録する `os.hostname()` と一致させる |
| command / args / cwd | すべて絶対パス、args は `--resume` 固定 | argv 配列起動用のローカル allowlist |
| 要求有効期限 | 21,600 秒（6 時間） | `rerun_requested_at` からの受付期限 |
| ポーリング空白時間の申告 | 300 秒 | cron 既定との整合検証 |
| claim 期限 | `batchTimeoutSec + 600秒` | ランナー上限より先に stale としない |
| profile ごとのチェック済み要求上限 | 3 件 | 連投 DoS の抑制 |
| 1 回の overflow 取消上限 | 3 件 | 更新 API 数の上限 |
| 1 回の stale 回収上限 | 3 件 | 更新 API 数の上限 |
| 候補取得上限 | 上記を処理できる有限件数 | 巨大応答と無制限処理の防止 |
| HTTP タイムアウト | 30 秒 | ハング防止 |
| ポーリング間隔 | crontab で 5 分 | 二重設定を避ける |
| flock ファイル | `/run/lock/ksql-poll-control.lock` | kintone 値から組み立てない |

第 1 段階は単一 host / profile を対象とする。将来 map 化しても、レコード値は allowlist のキー検索にだけ使い、パス、環境変数名、cwd の組み立てには使わない。

起動前に未知キー、相対パス、`--resume` 以外の argv、非 HTTPS URL、範囲外上限、未定義の環境変数を拒否する。要求有効期限がポーリング空白時間以下なら API 呼び出し前に停止する。claim 期限は対応する `ksql.config.json` の `limits.batchTimeoutSec` 変更時に同じ PR で見直す。

## 6. ポーラーの処理フロー

### 6.1 クエリ

profile と host は必ずローカル設定値を kintone クエリ用にエスケープして埋める。レコードから取得した値を実行対象の決定に使わない。

候補クエリは概念上、次の条件だけとする。**`record_type` もクエリで絞らない** — 一覧ではジョブ名の見える JOB 行のほうがクリックしやすく、JOB へのチェックをクエリで落とすと永遠に滞留してリマインダー（record_type を見ない）が誤発報する。取得してコードで判定し、`CANCELED` + 理由（BATCH 親レコードへの誘導）で返す（2026-08-27 運用初日に検出・修正）。

```text
profile = "<ローカル profile>"
and host = "<ローカル host>"
and rerun_request in ("REQUEST")
order by started_at asc
limit <有限件数>
```

`started_at asc` により、同一 profile / host の古い BATCH から FIFO で処理する。JOB、別 profile、別 host は候補にしない。

**`status` と `rerun_state` の判定はクエリではなくコードで行う。** 取得後に `rerun_state` で、新規（未選択）、Exit 5 継続（`REQUESTED`）、実行中（期限内の `CLAIMED`）、stale（期限超過の `CLAIMED`）、再要求（終端値のままチェックあり）へ振り分ける。失敗系（`FAILED` / `ABORTED` / `TIMEOUT`）でないレコードにチェックが付いていた場合は、**revision 条件付きで `CANCELED` にしてチェックを外し、理由を返す**（固定文言は §6.7）。

クエリ側で `status` を絞ると、成功済み BATCH に人間が誤ってチェックを付けたレコードを**ポーラーが永久に取得しない**。その結果、§4.4 手順 8 のリマインダーが**ポーラーは正常なのに発報する**（誤アラート）。人間の側にも理由が返らない。取り消しという形で返すほうが運用上正しい。

この取消は **profile ごとのチェック済み要求上限の判定より前**に処理し、誤操作レコードが上限を食い潰さないようにする。

stale 候補も同じ 1 回の候補 GET に含まれる。取得後の配列を通常要求、期限内の実行中、stale に分割し、stale を通常 claim の処理関数へ渡してはならない。未選択の判定・動作確認は `rerun_state in ("")` 相当で行い、「空」という選択肢や `rerun_state = ""` を導入しない。

GET の `fields` には少なくとも `$id`、`$revision`、`更新日時`、`更新者`、`record_type`、`status`、`batch_id`、`profile`、`host`、`started_at` と 10 個の `rerun_*` を含める。

### 6.2 stale 回収

stale 候補は revision 条件付き PUT で `rerun_state = UNKNOWN`、`rerun_request = []`、固定要約、claim 情報のクリアへ更新するだけで、子プロセスを起動しない。revision 競合は別処理済みとして無視し、無条件 PUT や自動再取得による実行は行わない。1 回の回収件数を `staleRecoveryLimit` 以下に制限する。

これは kSQL Flow の `recoverStale()` が RUNNING ロックを `TIMEOUT` にする処理とは別である。ランナー側の stale 回収が元 BATCH の revision を進める可能性は、§6.5 の競合処理で扱う。

### 6.3 通常要求の受付、有効期限、要求証跡

通常要求は FIFO の先頭 1 件だけを起動する。profile ごとのチェック済み要求件数が上限を超えた場合は、新しい超過分を 1 回の取消上限まで revision 条件付きで `CANCELED` にし、チェックを外す。

有効期限の基準は `rerun_requested_at` だけとする。新規要求（未選択 + チェックあり）と再要求（終端値 + チェックあり）の候補 GET では、次の規則で要求時刻と要求者を取り直す。Exit 5 継続（`REQUESTED` + チェックあり）では退避済みの値を据え置く。

* 新規要求・再要求では、GET で得た `更新日時` を要求時刻とする
* 新規要求・再要求では、同じ GET で得た `更新者` の **`code`** を要求者とする。`name`（表示名）は改姓・改名で変わるため証跡に使わない
* claim PUT で、この 2 値を `CLAIMED` と同時に退避する
* Exit 5 後の再 claim では既存値を保持し、書き換えない

有効期限判定はこの有効な要求時刻に対して行う。期限超過なら revision 条件付きで `EXPIRED` にしてチェックを外し、起動しない。`更新日時` を継続的な期限基準にしてはならない。Exit 5、結果更新、ランナーの `resendPending()` / `recoverStale()` により更新日時が進み、期限が延長されるためである。BATCH の `作成日時` も要求時刻ではないため使わない。

**既知の限界**: 新規要求・再要求で使う `更新日時` はあくまで要求時刻の代理である。退避される前にランナーの `resendPending()` / `recoverStale()` が同じレコードを更新すると、`更新日時` が進んで TTL の起点が後ろへずれる。成立条件は「ポーラーが長時間停止している」かつ「そのレコードに再送保留がある」で稀であり、挙動も期限が延びる側（緩い側）に倒れるだけなので、追加の対策は取らない。

### 6.4 claim と子プロセス起動

候補 GET の `$revision` を条件に PUT し、次を一体で更新する。

* `rerun_state = CLAIMED`
* `rerun_request = ["REQUEST"]`（claim 中もチェックを維持）
* `rerun_claimed_host = <ローカル host>`
* `rerun_claim_expires_at = 現在 + batchTimeoutSec + 余裕`
* `rerun_attempt = 既存値 + 1`
* 新規要求・再要求では `rerun_requested_at` / `rerun_requested_by` を退避。Exit 5 継続では据え置き
* 新規要求・再要求では前回の `rerun_exit_code` / `rerun_result` / `rerun_batch_id` をクリア

claim の revision 競合時は、別の書き手が先に更新したものとして子プロセスを起動せず Exit 0 とする。claim 成功応答の新 revision を保持し、その revision を結果更新へ連鎖させる。

claim 成功後だけ、ローカル設定の固定絶対パスを argv 配列で起動する。起動する子プロセスは `run_batch.sh --resume` の 1 つだけである。stdout / stderr は既存 cron ログへ流すが、メモリに捕捉せず、kintone へ転記しない。ポーラーから `git` は起動しない。

### 6.5 revision 連鎖と競合時の再適用

通常の成功経路は次の revision 連鎖とする。

```text
候補 GET の revision r0
  -> claim PUT(revision=r0)
  -> 応答 revision r1
  -> 結果 PUT(revision=r1)
```

kSQL Flow の `LogAppClient.update()` は revision 条件を付けない。さらに `resendPending()` は前回失敗したログ書込を次回実行時に旧レコードへ再送し、`recoverStale()` も RUNNING レコードを更新する。このため、claim 後に元の失敗 BATCH の revision が進み、結果 PUT が競合する可能性がある。ただしランナーは `rerun_*` を一切書かないため、リラン状態の値は競合で壊れない。

結果 PUT が revision 競合した場合は、同じ `$id` を 1 回だけ再 GET する。`rerun_request` にチェックがあり、`rerun_state = CLAIMED`、`rerun_claimed_host` が自ホスト、要求の証跡が claim 時と一致することを確認し、最新 revision を条件に同じ `rerun_*` 結果を 1 回だけ再適用する。再 GET で別状態になっていた場合、または再適用も失敗した場合は、それ以上更新せず stale 回収と人手照合に委ねる。無条件 PUT、無制限リトライ、子プロセスの再起動は行わない。

### 6.6 `rerun_batch_id` と `git_ref` の確定

Exit 5 以外では、子プロセス終了後に同じログアプリを 1 回 GET し、次をすべて満たす BATCH を検索する。

* `record_type = BATCH`
* `profile` / `host` がローカル設定値と一致
* `started_at` が claim 時刻より後
* 元の要求レコード自身ではない

GET の `fields` に `batch_id` と `git_ref` を含める。ポーラーは `git` を起動せず、実行時 git リビジョンはこの照合結果から運用ログへ記録する。`git_ref` は実行可否の条件にしない。

候補件数ごとの規則は次のとおりである。

| 候補件数 | `rerun_batch_id` | 理由 |
| --- | --- | --- |
| 0 件 | 空欄 | resume 対象が無い場合、`runAll.ts` は BATCH 作成前に Exit 0 を返すため正常 |
| 1 件 | その BATCH の `batch_id` | 帰属を一意に確定できる |
| 2 件以上 | 空欄 | claim から結果更新までに定期 cron が割り込むと帰属を断定できない |

0 件と 2 件以上は異常にせず、Exit 0 なら `SUCCESS` とする。別 host / profile、JOB、claim 以前の BATCH を採用しない。

### 6.7 Exit Code と固定要約

| Exit / 事象 | `rerun_state` | チェック解除 | `rerun_result` の固定文言 |
| --- | --- | --- | --- |
| 0 | `SUCCESS` | あり | `リランが正常終了しました。実行ログアプリを確認してください。` |
| 1 | `FAILED` | あり | `リランを開始できませんでした（設定・検証エラー、または再開できる直近バッチが見つかりません）。実行ログアプリを確認してください。` |
| 2 | `FAILED` | あり | `業務アサート違反で安全停止しました。対象データを確認してください。` |
| 3 | `FAILED` | あり | `実行時エラーで終了しました。基盤と実行ログアプリを確認してください。` |
| 4 | `FAILED` | あり | `一部のジョブが失敗しました。実行ログアプリを確認してください。` |
| 5 | `REQUESTED` | **なし** | `別のバッチが実行中のため、要求状態に戻しました。` |
| signal / その他 | `UNKNOWN` | あり | `終了結果を確認できません。実行ログアプリと VPS を照合してください。` |
| stale 回収 | `UNKNOWN` | あり | `確保期限を超過したため結果不明にしました。自動再実行はしていません。` |
| 期限切れ | `EXPIRED` | あり | `要求の有効期限を超過したため実行しませんでした。` |
| 受付上限超過 | `CANCELED` | あり | `受付条件を満たさないため取り消しました。` |
| 対象が失敗系でない | `CANCELED` | あり | `対象が失敗したバッチではないため取り消しました。失敗した実行の記録を選び直してください。` |
| 対象が JOB レコード | `CANCELED` | あり | `対象がバッチレコードではないため取り消しました。レコード種別 BATCH（親レコード）にチェックしてください。` |

Exit 1 は設定不備だけでなく、再開できる直近バッチが無い場合にも返るため、原因を断定しない。Exit 5 は失敗ではなく待機であり、チェック、`rerun_attempt`、初回の `rerun_requested_at` / `rerun_requested_by` を保持して `REQUESTED` へ戻す。signal や 0〜5 以外は成功・失敗を断定しない。

結果更新では `rerun_exit_code`、`rerun_result`、`rerun_batch_id` を設定し、`rerun_claimed_host` / `rerun_claim_expires_at` をクリアする。Exit 5 ではチェックを維持し、それ以外の終端では `rerun_request = []` とする。固定辞書以外の API 本文、例外、stdout、stderr、SQL、レコード値は格納しない。

### 6.8 1 回の処理順

```text
poll_control.sh:
  flock を取得できなければ API を呼ばず Exit 0
  固定絶対パスの Node で poll_control.mjs を exec

poll_control.mjs:
  設定・環境変数・絶対パス・TTL 整合を検証
  現在時刻を一度確定
  チェック済み候補を有限件数で取得し、rerun_state で振り分ける
  期限内 CLAIMED は実行中として何もしない
  stale CLAIMED はチェックを外して UNKNOWN へ回収し、実行対象に混ぜない
  status が失敗系でない候補はチェックを外して CANCELED にする
  チェック済み要求の上限超過分を有限件数だけチェック解除 + CANCELED にする
  FIFO 先頭の新規・継続・再要求について要求時刻・要求者を確定
  期限超過ならチェックを外して EXPIRED にして終了
  revision 条件付きでチェックを維持したまま CLAIMED に更新する
  新規・再要求では前回結果をクリアして証跡を取り直し、Exit 5 継続では証跡を据え置く
  claim 成功時だけ固定 argv で run_batch.sh --resume を 1 回起動
  Exit 5 以外は新 BATCH を照合し、0 / 1 / 2件以上の規則を適用
  claim 応答 revision を条件に結果を書き戻す
  revision 競合なら再 GET + 1 回だけ再適用
```

## 7. kintone REST API と消費回数

通常ポーリングは `GET /k/v1/records.json` 1 回で `rerun_request` にチェックがある全候補を取得し、`rerun_state` による新規・継続・実行中・stale・再要求の振り分けはコードで行う。候補が無ければそこで終了する。

| 経路 | 主な API | 回数の目安 |
| --- | --- | --- |
| 待機ポーリング | 候補 GET | 5 分ごと、**288 回/日** |
| 通常リラン | claim PUT + BATCH 照合 GET + 結果 PUT | **1 回あたり 3 回** |
| 競合・補助更新あり | 再 GET + 再適用、期限切れ、stale、Exit 5 等 | **1 回あたり概ね 4 回以上** |
| 導入・設定変更 | 自前 check のフィールド定義 GET | 通常ポーリング外の都度実行 |

固定費 288 回/日と、リラン 1 回あたり 3〜4 回の変動費は、**既存の実行ログアプリの日次 API 枠に載る**。専用アプリの別枠ではない。複数ホストなら固定費は `288 × ホスト数` になる。待機中は業務アプリの枠を消費せず、実際の resume が業務アプリを操作した分はランナー側の通常消費となる。

Q12 のチェック維持・解除は claim PUT または結果・補助更新 PUT の同じ本文で行うため、追加の API 往復は発生しない。候補条件を `rerun_request` へ一本化しても待機時 1 回 / poll は変わらない。

HTTP クライアントは timeout、応答サイズ上限、非 JSON、同一 origin 外 redirect を拒否する。429 / retryable 5xx の再試行は回数上限と総時間上限を持つ。revision 競合は通常の HTTP リトライ対象にせず、§6.5 の意味論で処理する。応答喪失後の PUT を無条件に再送しない。

## 8. セキュリティ要件

* 起動する command、args、cwd、環境変数名、API パスはローカル設定の allowlist に固定する
* レコード値からパス、argv、cwd、環境変数名、URL を組み立てない
* `spawn(..., { shell: false })` を使い、`sh -c`、文字列 command、shell 展開を禁止する
* 起動する子プロセスは `run_batch.sh --resume` だけとし、`git`、`curl`、任意コマンドを起動しない
* stdout / stderr は kintone へ転記しない。固定要約辞書と `rerun_batch_id` だけを書き戻す
* トークン、API エラー本文、認証ヘッダー、SQL リテラル、レコード値をポーラーログへ出さない
* URL は HTTPS、設定 origin 固定とし、同一 origin 外 redirect を拒否する
* profile ごとのチェック済み要求上限、候補 GET limit、overflow / stale 更新上限、1 ポーリング 1 起動、HTTP 応答サイズ上限で DoS を抑制する
* `.env` は Git 管理外、`chmod 600`、ポーラーと通常バッチは同じ専用 OS ユーザーで動かす
* API トークンがフィールド単位アクセス権の対象外であることを運用手順へ明記する

## 9. cron と GitHub Actions

### 9.1 cron

通常バッチの cron 行は変更せず、その下にポーラーを追加する。既定は終日 5 分間隔とする。

```cron
*/5 * * * * /opt/ksql/my-ksql-jobs/scripts/poll_control.sh >> /var/log/ksql/poll-control.log 2>&1
```

営業時間限定を既定にも推奨にもしてはならない。この仕組みの目的は休日・外出先でも通知から復旧できることだからである。運用上ポーリング空白を設ける場合は、その最大空白時間より要求有効期限を長くしなければならず、有効期限が空白時間以下なら起動時に停止する。

`poll_control.sh` は自身の場所からリポジトリルートを固定的に解決し、固定パスの `flock` と Node を使う。導入時に `command -v node` と `command -v flock` で実パスを確認してファイルへ固定する。`poll-control.log` は logrotate 対象にする。

### 9.2 GitHub Actions（#6）との関係

* `daily-batch.yml` / `pr-check.yml` ともワークフローファイルの変更は不要である
* 復旧用 `workflow_dispatch` を残す必要がなくなり、書込可トークンを GitHub Secrets に置かない構成にできる
* 定期実行の主は VPS cron または Actions のどちらか 1 つに決め、両方を有効にしない
* ポーラーは VPS / オンプレ専用であり、使い捨ての Actions runner には載せない
* cron、ポーラー、Actions、SSH が衝突しても仕様 §5.5 の分散ロックが Exit 5 で止めるが、ロックを二重スケジュールの常用手段にはしない

## 10. テスト計画

### 10.1 ローカル試験

Node 22 の `node:test` とローカル HTTP モックを使い、実 kintone と実ランナーを必要としない状態機械を網羅する。

* **設定**: 未知キー、相対パス、非 HTTPS、未定義 token、`--resume` 以外の args、範囲外上限を API 前に拒否する
* **Schema check**: 10 フィールドの欠落、型違い、`rerun_request` の選択肢が `REQUEST` 1 つでないこと・既定チェックあり、`rerun_state` の不足・余分な選択肢・必須化を検出する。既存 `init-logapp` / `--check-logapp` に依存しない
* **クエリ**: `record_type = BATCH`、ローカル profile / host、`rerun_request in ("REQUEST")`、`started_at asc`、有限 limit だけで候補を取ることを確認する。`status` / `rerun_state` で候補を落とさず、コードで振り分けることも確認する
* **状態振り分け**: 未選択は新規、`REQUESTED` は Exit 5 継続、期限内 `CLAIMED` は無処理、期限超過 `CLAIMED` は stale、終端値 + チェックありは再要求になることを確認する
* **通常 / stale 分離**: stale はチェック解除 + `UNKNOWN` 更新だけで spawn せず、通常要求だけが claim へ進む
* **要求証跡**: 新規要求・再要求では GET の `更新日時` / `更新者.code` を claim と同時に退避し、Exit 5 後の再 claim では変わらない
* **有効期限**: `rerun_requested_at` の境界直前は claim、境界時刻以後は `EXPIRED`。`更新日時` が進んでも延長しない
* **claim**: GET の revision を PUT に渡し、チェックを維持したまま `CLAIMED` にする。競合時に spawn せず、claim 応答 revision を結果 PUT へ渡す
* **結果競合**: claim 後にランナー相当の無条件更新を挟み、結果 PUT 競合後の再 GET + 1 回再適用で成功する。2 回目も失敗したら停止する
* **起動**: `shell: false`、固定 command / cwd、args が `--resume` だけである。空白、引用符、改行、`../` を含むレコード値でも argv が変わらない
* **Exit**: 0 / 1 / 2 / 3 / 4 / 5、signal、未知 code の状態、固定要約、§6.7 のチェック解除有無を検証する
* **Exit 5**: チェックを残して `REQUESTED` へ戻り、attempt は増え、要求日時・要求者・有効期限の起点は変わらない
* **再要求**: `SUCCESS` / `FAILED` / `UNKNOWN` / `EXPIRED` / `CANCELED` の各終端値でチェックを入れ直すと、前回結果をクリアし、要求日時・要求者を取り直して claim する
* **BATCH 照合**: claim 以前、要求レコード自身、別 host / profile、JOB を除外する。0 件は空欄、1 件だけ採用、2 件以上も空欄とする。照合 fields に `git_ref` があり、`git` を起動しない
* **DoS**: 1 回 1 起動、チェック済み要求上限、候補取得、overflow / stale 更新、応答サイズが設定上限を超えない
* **秘密**: token、API 本文、子 stdout / stderr、悪意あるレコード値が PUT 本文とポーラーログに現れない
* **HTTP**: timeout、429、retryable 5xx、revision 競合、応答喪失、非 JSON、巨大応答、同一 origin 外 redirect
* **flock**: 2 プロセスを同時起動し、片方だけが API モックへ到達する
* **静的検査**: `sh -c`、文字列 command、トークン出力、`git` / `curl` 起動がない

子プロセス試験には Exit Code だけを返す偽 `run_batch.sh` を一時ディレクトリへ置く。kSQL Flow 本体やエンジンは変更しない。

### 10.2 VPS 実機で確認すること

* cron の cwd、PATH、Node、`.env`、実行ユーザー、権限、`flock` の保持
* outbound HTTPS、DNS、TLS、既存ログアプリ用 API トークンの権限
* 実ユーザーにはフィールド単位アクセス権が効き、API トークンには効かないこと
* 自前 check が 10 フィールドの型・選択肢・既定を検証し、不備時に実行しないこと
* 実 kintone の revision 競合と、ランナーの revision 条件なし更新後の再 GET + 1 回再適用
* 通常 cron、ポーラー、SSH 手動実行がローカルロック・ログアプリ分散ロックで衝突すること
* v0.4.0 の `--resume` 選抜、元 as-of 引き継ぎ、BATCH 作成、`git_ref` 記録
* 終日 cron の自然発火、リマインダーの条件通知（`更新日時` + 1 時間、発報時再評価）、logrotate
* 実測 API 回数が待機時 1 回 / poll、リラン時 3〜4 回程度でログアプリ枠に載ること

### 10.3 VPS 実機ドリル

元 BATCH の `script_name` など識別可能な試験値と、業務アプリへ仕込む一意キーは `KSQL_FLOW_TEST_<日時>_<シナリオ>` とする。既存レコードを流用・変更しない。試験後は prefix で対象 ID を明示抽出し、削除前一覧、削除対象 ID、削除後 0 件を記録する。

1. **権限と Schema**: ジョブ管理グループは `rerun_request` だけ編集でき、`rerun_state` を含むその他の全編集可能フィールドは Everyone = 閲覧のみであること、API トークンは全フィールドを編集できること、自前 check が 10 フィールドを検査することを確認する。
2. **Exit 0 とチェック解除**: `KSQL_FLOW_TEST_EXIT0` の一時障害を解消し、失敗 BATCH の `rerun_request` にチェックを入れる。未選択 + チェックありから `CLAIMED` を経て `SUCCESS` + チェックなしになること、要求日時・要求者、元 as-of、batch ID、stdout 非転記を確認する。resume 対象 0 件も別に確認し、`SUCCESS`、チェックなし、`rerun_batch_id` 空欄を確認する。
3. **Exit 2**: `KSQL_FLOW_TEST_ASSERT` の ASSERT 違反データを残して要求し、`FAILED`、Exit 2、チェックなし、書込前停止、固定要約だけを確認する。
4. **Exit 3**: テスト profile だけ到達不能 URL または無効なテスト用 token に切り替え、`FAILED`、Exit 3、チェックなし、token / API 本文の非露出を確認して直後に戻す。
5. **Exit 5**: 長時間の通常バッチ中に要求する。`CLAIMED -> REQUESTED` でチェックが残ること、attempt 加算、要求日時・要求者の不変、通常実行終了後かつ期限内の再 claim を確認する。
6. **有効期限**: `KSQL_FLOW_TEST_EXPIRED` を使い、`更新日時` ではなく退避済み `rerun_requested_at` を基準に spawn なしで `EXPIRED` + チェックなしになることを確認する。
7. **claim 競合**: テスト用の別 lock ファイルを持つ 2 ポーラーを同じ要求へ向け、revision PUT は片方だけ成功し、起動が 1 回だけであることを確認する。本番 lock は無効化しない。
8. **結果更新競合**: claim 後、テスト用手順で元 BATCH の既存フィールドを更新して revision を進める。最初の結果 PUT が競合し、再 GET + 1 回再適用で `rerun_*` 結果が保存されることを確認する。
9. **stale（子起動前）**: claim 直後に試験用ハーネスを停止し、期限後に次回ポーラーが `UNKNOWN` + チェックなしへ回収し、自動再実行しないことを確認する。
10. **stale（子起動後）**: 子実行中にポーラーを停止し、ランナーの新 BATCH と元要求の `UNKNOWN` + チェックなしを人間が照合できることを確認する。
11. **BATCH 2 件以上**: claim 後に `KSQL_FLOW_TEST_` 接頭辞の**合成 BATCH レコードを投入**し、帰属を断定せず `rerun_batch_id` が空欄になることを確認する。通常実行を割り込ませる方法では再現できない — 分散ロックにより、ポーラーの resume 実行中に来た通常実行は `acquireLock()` で弾かれ、**BATCH レコードを作らずに Exit 5 で終わる**（レコード作成は `acquireLock()` 自身が行う）。実運用でこの経路に入るのは「resume 完了後・結果 PUT 前」の数秒だけであり、極めて稀である。
12. **失敗系でない対象**: 成功した BATCH（`status = SUCCESS`）にチェックを付け、**spawn せずに `CANCELED` + チェックなし + 理由の固定文言**が返ること、リマインダーの対象にならないことを確認する（§6.1）。
13. **再要求**: 終端済みの `KSQL_FLOW_TEST_REREQUEST` レコードへもう一度チェックを入れ、終端値のままの候補が再要求に振り分けられること、前回の終了コード・結果・実行バッチ ID が claim 時にクリアされること、要求日時・要求者を取り直すこと、終端時に再びチェックが外れることを確認する。
14. **ポーラー停止リマインダー**: 実機設定済みのリマインダーを使う。cron 行を一時停止し、未選択のレコードへチェックを入れ、`更新日時` の 1 時間後の発報時再評価で通知が届くことを確認する。次にポーラー正常時は 5 分以内に `CLAIMED` となり通知されないこと、Exit 5 で `REQUESTED` のまま 1 時間を超えても条件対象外で通知されないことを確認して復旧する。

異常終了用フックは本番ファイルの隠し環境変数として残さず、試験用コピーまたは依存注入可能なテストハーネスで実現する。

## 11. 段階分け、完了条件、見積り

### 第 1 段階: ジョブリポジトリのポーラー（MVP）

対象は `my-ksql-jobs`、実績確認後に `ksql-flow-template` とする。kSQL Flow 本体、公開 CLI、`ksql.config.json` Schema、`init-logapp`、`--check-logapp`、エンジンは変更しない。

成果物:

* Node 22 本体、薄い `flock` ランチャー、ポーラー専用設定と設定例
* 既存ログアプリへの 10 フィールド追加、アクセス権、一覧、リマインダー設定の手順
* ポーラー自前の 10 フィールド契約 check
* ローカル単体 / 結合試験、秘密情報検査
* 終日 cron、logrotate、GitHub Actions との役割分担、障害時の人手照合手順
* `KSQL_FLOW_TEST_` 限定の VPS ドリル記録と後片付け記録

完了条件:

* §10.1 のローカル試験がすべて通る
* §10.3 の Exit 0 / 2 / 3 / 5、有効期限、claim 競合、結果更新競合、stale、再要求、0 件 / 2 件以上照合を実機で確認する
* 実ユーザーと API トークンの権限差、新規要求・再要求での要求日時・要求者の退避、Exit 5 継続での据え置きを実機で確認する
* 通常要求と stale が別処理で、stale から自動再実行されない
* kSQL Flow 本体、CLI、config schema、`init-logapp` / `--check-logapp`、エンジンに差分がない
* レコード値から任意 command / argv / cwd を作れず、stdout、秘密、API 本文が書き戻されない
* 終日 5 分間隔の自然発火、実機設定済みリマインダーの発報時再評価、API 消費を確認する

見積り: **4.5〜6.5 人日**。

* 実装・ローカル試験: 2.5〜3.5 人日
* 10 フィールド追加・権限・自前 check・リマインダー設定: 0.5〜1 人日（フィールド・権限・リマインダーの実機設定は実施済み）
* VPS 配備・競合を含む全ドリル・後片付け: 1.5〜2 人日

### 第 2 段階: 公式サブコマンド化

第 1 段階の運用実績、API 消費、競合・障害記録をレビューした後、`ksql-flow poll-control` 相当を別の仕様裁定と新バージョンで検討する。

移管候補:

* `poll-control` CLI、共通 HTTP / retry / masking、設定バリデーション
* `poll-control check-logapp-rerun` 相当の契約検査
* 10 フィールドを含むテンプレート ZIP、README、JSON Schema、npm 配布物
* Linux 以外の起動・排他方式、複数ホスト実行プール
* metrics、heartbeat、監視、互換性・移行ポリシー
* help、Exit Code、設定エラーの公式契約

公式化しても公開済み `run-all --resume` の意味論は変えない。`--expect-batch`、`--resume-batch`、自動 resume、通常実行、バックフィルは持ち込まない。

完了条件:

* 第 1 段階と同じ状態機械・セキュリティ・revision 競合試験が公式 CLI で通る
* 既存 CLI / config / `init-logapp` / `--check-logapp` の後方互換試験が通る
* テンプレート ZIP と npm 配布物に 10 フィールド契約と秘密情報がないことを検査する
* Linux 配布物で cron / flock の実機回帰を完了する

見積り: **5〜8 人日 + リリース作業 1 人日**。

* CLI / 設定 / 移行設計: 1〜1.5 人日
* 実装・共通化: 2〜3 人日
* テンプレート / ドキュメント / 配布物: 1〜1.5 人日
* クロス環境・回帰試験: 1〜2 人日

複数ホスト実行プールは別見積りとする。

## 12. 実装順序

1. **実施済み**: 実ログアプリへ 10 フィールド、Everyone / ジョブ管理のフィールドアクセス権、`更新日時` + 1 時間のリマインダーを設定・デプロイ・検証する
2. Q12 の状態値、チェック不変条件、`poll-control.config.json` の契約を計画へ確定する
3. 自前の 10 フィールド Schema check、設定検証、HTTP クライアント、固定要約を実装する
4. チェック 1 条件の候補クエリ、状態振り分け、FIFO、有効期限、新規・再要求の証跡退避、Exit 5 継続の据え置き、DoS 上限を実装する
5. revision claim、claim 中のチェック維持、argv 配列起動、終端でのチェック解除を含む Exit map を実装する
6. BATCH 0 / 1 / 2 件以上照合と、結果更新競合時の再 GET + 1 回再適用を実装する
7. `flock` ランチャー、終日 cron、logrotate、運用手順を追加する
8. §10.1 のローカル試験と静的な秘密情報・危険 API 検査を完了し、自前 check を実機へ通す
9. §10.3 の VPS 実機ドリル（チェック解除、再要求、リマインダーを含む）を実施し、prefix 限定で後片付けする
10. 第 1 段階の実績をレビューし、`ksql-flow-template` 反映と第 2 段階を別途判断する

## 13. 未決事項

**無し。**

ホストキー、ログアプリ ID、絶対パスは配備パラメータであり、設計裁定を要する未決事項ではない。依頼者は実機で設定済みのジョブ管理グループとする。Q8（自動 resume の却下）、Q9（kintone 標準アクセス権）、Q10（手動リランと同一動作）、Q11（専用アプリを作らずログアプリへ統合）・Q11 追補 1〜3、Q12（人間入力とポーラー状態のチェックボックス分離）は裁定どおりとし、再提案しない。
