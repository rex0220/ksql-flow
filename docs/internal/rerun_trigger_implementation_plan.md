# kintone 実行指示ポーラー実装計画

* 作成: 2026-08-27（Codex）／**改訂: 2026-08-27**（Claude Code レビュー指摘を反映）
* 対象: kSQL Flow v0.4.0 を利用する VPS / オンプレのジョブリポジトリ
* 状態: **実装着手可**（レビュー: `reviews/poll_control_plan_review_claudecode-20260827.md`）
* 正: `rerun_trigger_design.md` v4。Q8・Q9・Q10 は裁定済みであり、本計画では再提案しない
* 関連: `ksql_flow_spec.md` §5.5・§6・§8・§10.3、`qiita_draft_09_vps_cron.md`

---

## 1. 目的と固定条件

kintone の実行指示アプリを VPS から定期ポーリングし、受け付けた指示に対して、SSH で行う場合と同じ固定コマンド `./run_batch.sh --resume` を起動する。変えるのは起動手段だけであり、リラン対象の選抜、元バッチの as-of 引き継ぎ、分散ロック、ログ記録は公開済みの kSQL Flow v0.4.0 に委ねる。

MVP の固定条件は次のとおりとする。

* 操作は `リラン` のみとし、通常実行とバックフィルは受け付けない
* 単一ホスト構成、at-least-once、ホスト単位の `flock`、指示の有効期限を採用する
* kSQL Flow v0.4.0 と `../kintone-sql-tools` は変更しない
* 対象バッチ固定、`git_ref` 一致による停止、新しい resume 選抜規則は導入しない
* 実ドメインとトークンはコミットしない。例示は `https://example.cybozu.com` と環境変数名だけにする
* 実 kintone での書込試験は、指示の識別名と業務アプリのテストキーを `KSQL_FLOW_TEST_` で始める

## 2. 成果物の配置

### 2.1 判断

第1段階の実装成果物は kSQL Flow 本体ではなく、利用者のジョブリポジトリ `my-ksql-jobs` に置く。再利用用の見本は別リポジトリ `ksql-flow-template` に反映する。

想定配置は次のとおり。

```text
my-ksql-jobs/
├── .env                              # 既存。秘密値、chmod 600、Git 管理外
├── jobs/
├── ksql.config.json                  # 既存。ランナー専用
├── poll-control.config.json          # 新規。ポーラー専用、秘密値なし
├── run_batch.sh                      # 既存。変更しない
├── scripts/
│   ├── poll_control.sh               # flock と Node 起動だけを担う薄いランチャー
│   └── poll_control.mjs              # REST API・状態遷移・子プロセス起動の本体
└── test/
    └── poll_control.test.mjs         # node:test によるローカル試験
```

理由は次のとおり。

* `run_batch.sh` の絶対パス、ホスト名、profile の種類、cron 時刻、指示アプリ ID は配備先固有であり、ジョブと同じ変更管理単位に置くのが自然である
* 第1段階の目的は v0.4.0 を一切変えずに実績を取ることである。kSQL Flow 本体へ入れると、新しい CLI 契約、設定スキーマ、配布物、互換性保証が発生する
* `run_batch.sh --resume` をそのまま呼ぶため、起動手段だけを変えるという v4 §2 と Q10 を構造的に守れる
* ポーラーとジョブ設定を同じ PR でレビューでき、allowlist と実際の配備先がずれにくい

### 2.2 テンプレート同梱の影響

第1段階の実績確認後、`ksql-flow-template` には上記スクリプト、秘密値を含まない設定例、cron 例、セットアップ手順を同梱できる。利用者は clone 後にホスト固有値とアプリ ID を埋めるだけになる一方、次の保守責任が増える。

* Ubuntu 以外を含む `/usr/bin/flock`・Node のパス差異を説明する必要がある
* テンプレートの `run_batch.sh` とポーラーの固定 argv の整合を契約テストで確認する必要がある
* kintone 実行指示アプリのフィールド、選択肢、アクセス権、一覧をテンプレート版数として管理する必要がある
* `poll-control.config.json` の互換性と移行手順が利用者向け契約になる

kSQL Flow npm パッケージの `template/` に実行指示アプリ ZIP まで同梱するのは第2段階へ回す。実施時は `package.json` の `files`、テンプレート README、ZIP の契約テスト、リリースノート、配布物の秘密情報検査が追加で必要になる。

## 3. 実装言語

### 3.1 採用: Node 22 + 薄い shell ランチャー

REST API と状態遷移の本体は、依存パッケージを追加しない ESM の Node スクリプトとする。shell は `flock` を取得して Node を `exec` する部分だけに限定する。

採用理由:

* VPS には Node 22 が確実にあるが、`jq` がある保証はない。shell + `curl` + `jq` を採ると jq の導入・版数・障害時の切り分けが新しい運用要件になる
* Node 22 の標準 `fetch`、`AbortSignal.timeout`、`child_process.spawn`、`URL`、JSON API だけで実装でき、npm 依存を増やさずに済む
* kintone 応答の型・必須フィールド・列挙値・revision を明示的に検証しやすい
* `spawn(command, args, { shell: false })` により、文字列連結や `sh -c` を使わない argv 配列起動を直接保証できる
* HTTP エラー本文とトークンを分離し、固定要約だけを書き戻す経路をテストしやすい

`flock` は Node 標準 API に無いため、`scripts/poll_control.sh` が絶対パスのロックファイルを使って `/usr/bin/flock -n` を実行する。ロック取得失敗は「別ポーラーが動作中」の正常スキップとして、kintone API を呼ばず Exit 0 とする。API 処理を shell へ戻したり、Node から `curl` を起動したりはしない。

## 4. kintone 実行指示アプリ

### 4.1 フィールド定義

表示名とフィールドコードを分離し、プログラムはフィールドコードだけを使用する。`対象プロファイル` と `対象ホスト` の選択肢は配備ごとに allowlist と一致させる。表中の `prod` / `stg` / `vps-batch-01` は例であり、実ドメインや秘密値ではない。

| 表示名 | フィールドコード | kintone 型 | 必須 | 初期値・選択肢 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 指示識別名 | `request_key` | 文字列（1行） | 必須 | なし | 人間向け識別。実機試験は `KSQL_FLOW_TEST_...` |
| 操作 | `operation` | ドロップダウン | 必須 | `リラン` のみ、初期値 `リラン` | allowlist キー。自由入力不可 |
| 対象プロファイル | `target_profile` | ドロップダウン | 必須 | 例: `prod` / `stg` | ローカル profile allowlist のキー |
| 対象ホスト | `target_host` | ドロップダウン | 必須 | 例: `vps-batch-01` | 拾う単一ホストの allowlist キー |
| 状態 | `state` | ドロップダウン | 必須 | `受付待ち` / `実行中` / `完了` / `失敗` / `結果不明` / `期限切れ` / `取消`、初期値 `受付待ち` | ポーラーが管理する状態 |
| 確保ホスト | `claimed_host` | 文字列（1行） | 任意 | 空 | claim したローカルホストキー |
| 確保期限 | `claim_expires_at` | 日時 | 任意 | 空 | stale 判定時刻 |
| 試行回数 | `attempt_count` | 数値 | 必須 | `0`、最小 0、整数 | claim 成功回数。Exit 5 でも保持して再受付 |
| 実行開始日時 | `execution_started_at` | 日時 | 任意 | 空 | claim 成功時刻 |
| 実行終了日時 | `execution_finished_at` | 日時 | 任意 | 空 | 子プロセス終了確認時刻 |
| 実行バッチ ID | `execution_batch_id` | 文字列（1行） | 任意 | 空 | ログアプリの BATCH レコードとの照合 |
| 終了コード | `exit_code` | 数値 | 任意 | 空、整数 | kSQL Flow の Exit Code |
| 結果要約 | `result_summary` | 文字列（複数行） | 任意 | 空 | allowlist から選ぶ固定文言だけを格納 |
| 実行ログ URL | `log_url` | リンク | 任意 | Web サイトリンク、空 | ログアプリの検索画面への固定生成リンク |
| 実行時 git_ref | `executed_git_ref` | 文字列（1行） | 任意 | 空 | **ログアプリの BATCH から転記**。記録だけに使い、実行可否には使わない |

`$id`、`$revision`、`作成者`、`作成日時`、`更新者`、`更新日時` は kintone のシステムフィールドを利用する。独自の依頼者フィールドは作らない。`$revision` は claim と結果更新の楽観ロックに、`作成日時` は FIFO と有効期限に使う。

`request_key` は実行引数には使わない。重複禁止にもせず、監査と試験データ識別だけに使う。

### 4.2 アクセス権の設定手順

1. アプリ管理者が上記フィールドを作り、`state` の初期値を `受付待ち`、`operation` の初期値を `リラン` にする。
2. アプリのアクセス権で、リラン依頼者グループには「レコード閲覧・追加」だけを与え、編集・削除・アプリ管理は与えない。これがリラン実行権限になる。グループの選定は運用判断とする。
3. 通知受信だけのグループにはレコード閲覧だけを与える。
4. 運用管理者には閲覧・追加・編集・削除を与え、誤登録を `取消` にできるようにする。
5. フィールドのアクセス権で、依頼者が入力できるのは `request_key`、`operation`、`target_profile`、`target_host` だけとする。`state` 以下の結果・claim フィールドは閲覧のみとし、編集可能者を運用管理者に限定する。
6. ポーラー用 API トークンを発行し、権限は「レコード閲覧・編集」だけにする。追加・削除は与えない。トークン値は VPS の `.env` に `KSQL_CONTROL_TOKEN` として保存し `chmod 600`、Git 管理外とする。
7. kSQL Flow の既存ログアプリ用トークンは、ランナーの resume とポーラーの実行バッチ照合に必要な閲覧、ランナーに必要な追加・編集だけを持たせる。実行指示アプリ用トークンとは分ける。
8. 設定を運用環境へ反映後、依頼者アカウントで「追加できるが結果フィールドを変更できない」、通知受信者で「閲覧だけ」、API トークンで「取得と更新はできるが追加できない」を確認する。
9. `受付待ち` がポーリング間隔の 2〜3 倍を超えて残った場合の kintone 条件通知を設定し、ポーラー停止を人間へ知らせる。

指示アプリとログアプリは統合しない。人間追加・VPS 編集という指示側の権限と、VPS 追加・編集・人間閲覧というログ側の権限が逆であり、API 枠、通知、状態機械も分離したほうが事故範囲を小さくできるためである。

## 5. 設定

### 5.1 保存先

ポーラー設定はトップレベルの `poll-control.config.json` に分離する。既存 `ksql.config.json` は kSQL Flow の公開 JSON Schema が未知キーを拒否するため、ポーラー設定を追加すると v0.4.0 の起動を壊す。ランナーを変更しない条件からも別ファイルが必要である。

秘密値は両 JSON に直接書かず、環境変数名だけを保持する。`.env` は既存 `run_batch.sh` と共用する。

### 5.2 設定項目

| 設定 | 置き場所 | 例 / 既定 | 理由 |
| --- | --- | --- | --- |
| kintone ベース URL | `poll-control.config.json` | `https://example.cybozu.com` | API URL とログリンクの固定基点 |
| ゲストスペース ID | 同上 | `null` | URL 形式を固定分岐するため。MVP で不要なら null |
| 実行指示アプリ ID | 同上 | 数値例のみ | 配備先固有。論理名解決をポーラーへ持ち込まない |
| 指示アプリ token 環境変数名 | 同上 | `KSQL_CONTROL_TOKEN` | 値を JSON に書かない |
| ログアプリ ID | 同上 | 数値例のみ | 実行バッチ ID 照合とリンク生成用 |
| ログ token 環境変数名 | 同上 | `KSQL_TOKEN_LOGS` | 既存ランナー用秘密値を再利用し、値は書かない |
| 自ホストキー | 同上 | `vps-batch-01` | kintone ドロップダウンおよび `os.hostname()` との一致を起動前検証 |
| profile allowlist | 同上 | `prod` / `stg` をキーとする map | レコード値をパスへ変換しないため |
| profile ごとの command / args / cwd | 同上 | すべて絶対パス、args は `['--resume']` 固定 | allowlist の値はローカル設定だけに置く |
| 指示有効期限 | 同上 | 21,600 秒（6時間） | v4 §4.5 の受付期限。**ポーリング空白時間より長いこと**（§9.1） |
| ポーリング空白時間の申告 | 同上 | 既定 300 秒（終日 5 分間隔） | 有効期限との整合を起動時に検証するための宣言値 |
| claim 期限 | 同上 | `batchTimeoutSec + 600秒` | ランナー上限より先に stale 扱いしない |
| profile ごとの受付待ち上限 | 同上 | 3件 | 連投時の実行回数を抑える |
| 1回の overflow 取消上限 | 同上 | 3件 | 攻撃時にも更新 API 数を有限にする |
| 1回の stale 回収上限 | 同上 | 3件 | 1ポーリングの API 消費を有限にする |
| HTTP タイムアウト | 同上 | 30秒 | ポーラーのハングを避ける |
| ポーリング間隔 | crontab | 5分 | cron が発火源なので二重設定にしない |
| flock ファイル | `poll_control.sh` のローカル定数 | `/run/lock/ksql-poll-control.lock` | kintone 値から組み立てない |

profile map の各値は、たとえば command が `/opt/ksql/my-ksql-jobs/run_batch.sh`、args が `--resume`、cwd が `/opt/ksql/my-ksql-jobs` という完全な固定値を持つ。`target_profile = prod` は map のキー検索にだけ使い、`/opt/.../${target_profile}` のような補間は禁止する。自ホストキーは kSQL Flow v0.4.0 がログアプリの `host` に記録する `os.hostname()` と完全一致させ、指示と BATCH レコードを同じ値で照合する。

起動時に設定全体を検証し、不明キー、相対パス、`--resume` 以外の argv、重複 profile、非 HTTPS URL、範囲外の上限、未定義の環境変数があれば API 呼び出し前に停止する。**指示有効期限がポーリング空白時間以下の場合も停止する** — この組み合わせは「拾う前に必ず期限切れになる」設定であり、§9.1 の事故を構成上防ぐ。`claim` 期限は、対応する `ksql.config.json` の `limits.batchTimeoutSec` 変更時に同じ PR で見直す。第1段階ではランナー設定の内部構造へ依存して自動読込しない。

## 6. ポーラーの処理フロー

### 6.1 状態遷移

```text
受付待ち --期限切れ------------------------------> 期限切れ
受付待ち --revision 付き claim-------------------> 実行中
受付待ち --profile ごとの受付上限超過------------> 取消
実行中   --Exit 0--------------------------------> 完了
実行中   --Exit 1 / 2 / 3 / 4--------------------> 失敗
実行中   --Exit 5--------------------------------> 受付待ち
実行中   --未知 Exit / signal / 結果更新不能------> 結果不明相当
実行中   --確保期限超過を次回ポーラーが検知------> 結果不明
```

「結果更新不能」の場合は kintone 自体へ状態を書けないため、実レコードは一時的に `実行中` のまま残る。次回到達時の stale 回収で `結果不明` に収束させる。自動で `受付待ち` に戻して再実行はしない。

Exit 4 は部分成功であり、人間の確認が必要なので指示状態は `失敗` とする。Exit 1 も `失敗` とするが、**文言で原因を断定しない**。`--resume` は設定・検証エラーだけでなく「再開できる直近バッチの実行記録が見つからない」場合にも Exit 1 を返す（`runAll.ts` の `--resume に必要な直近バッチの実行記録が見つかりません`）ためで、「VPS の設定を確認せよ」と書くと依頼者を誤った方向へ誘導する。v4 で定めた主要経路 0 / 2 / 3 / 5 の意味は変更しない。signal 終了や 0〜5 以外は成功・失敗を断定せず `結果不明` とする。

書き戻す要約は次の固定辞書とし、子プロセスや API の出力を連結しない。

| 終了 | `result_summary` の固定文言 |
| --- | --- |
| 0 | `リランが正常終了しました。実行ログアプリを確認してください。` |
| 1 | `リランを開始できませんでした（設定・検証エラー、または再開できる直近バッチが見つかりません）。実行ログアプリを確認してください。` |
| 2 | `業務アサート違反で安全停止しました。対象データを確認してください。` |
| 3 | `実行時エラーで終了しました。基盤と実行ログアプリを確認してください。` |
| 4 | `一部のジョブが失敗しました。実行ログアプリを確認してください。` |
| 5 | `別のバッチが実行中のため、受付待ちに戻しました。` |
| signal / その他 | `終了結果を確認できません。実行ログアプリと VPS を照合してください。` |
| stale 回収 | `確保期限を超過したため結果不明にしました。自動再実行はしていません。` |
| 期限切れ | `指示の有効期限を超過したため実行しませんでした。` |
| allowlist 不一致 / 受付上限超過 | `受付条件を満たさないため取り消しました。` |

### 6.2 擬似コード

```text
poll_control.sh:
  /usr/bin/flock -n <固定ロック> を取得できなければ Exit 0
  固定絶対パスの /usr/bin/node で poll_control.mjs を exec

poll_control.mjs:
  設定を読み、schema・絶対パス・allowlist・環境変数を検証
  現在時刻を一度確定

  GET 実行指示レコード:
    対象ホスト = 自ホスト AND
    (状態 = 受付待ち OR
     (状態 = 実行中 AND 確保期限 < 現在))
    作成日時 asc、有限の limit、必要 fields のみ

  期限超過した実行中を、最大 staleRecoveryLimit 件処理:
    取得した $revision を付けて 状態=結果不明、固定要約 を PUT
    revision 競合なら他処理済みとして無視

  受付待ちが無ければ Exit 0
  最古の受付待ち candidate を選ぶ
  operation / target_profile / target_host / state を列挙値で再検証
  allowlist 不一致なら revision 付きで 取消 + 固定要約、起動しない

  candidate の profile について受付待ち一覧を有限件 GET
  pendingLimit を超える新しい指示を overflowUpdateLimit 件まで、
    revision 付きで 取消 + 固定要約に更新
  candidate 自身が上限外なら起動せず Exit 0

  作成日時 + requestTtlSec < 現在なら:
    revision 付きで 状態=期限切れ + 固定要約 を PUT
    Exit 0

  profile allowlist から固定 command / args / cwd / claimTimeout を取得

  revision 付き PUT で claim:
    状態=実行中、確保ホスト、自ホスト、確保期限、実行開始日時、
    試行回数+1、前回結果フィールドをクリア
  revision 競合なら誰かが確保したため、起動せず Exit 0
  応答の新 revision を保持

  spawn(command, args, { cwd, shell:false, stdio:'inherit' })
  子の stdout / stderr は既存 cron ログへ流すだけで、メモリに捕捉しない
  終了 code / signal を受け取る

  Exit 5 以外でログアプリを 1 回検索し、
    profile・host・claim 後の started_at に合う BATCH の
    batch_id と git_ref を取得（fields で限定）
    該当 0 件 → 両方とも空欄のまま正常終了（下の注記）
    該当 2 件以上 → 帰属を断定せず空欄にする（下の注記）
  batch_id が取れた場合だけ固定形式のログ検索 URL を生成

  exitMap から state と固定 result_summary を選ぶ
    0 => 完了
    1 / 2 / 3 / 4 => 失敗
    5 => 受付待ち（exit_code・終了時刻を記録、claim 欄をクリア）
    signal / その他 => 結果不明

  claim 応答の revision を付けて結果を PUT
  revision 競合または API 障害なら秘密を含まないローカル警告だけを出し、
    次回 stale 回収に委ねて非 0 終了
```

**実行バッチ照合が空欄になる 2 つの正常系**（実装者が異常と誤解しないこと）:

* **該当 0 件** — `--resume` は再実行対象が無ければ BATCH レコードを作らずに Exit 0 で終わる。`runAll.ts` は resume 選抜の直後（`--resume: 再実行が必要なジョブはありません`）で return し、BATCH レコードの作成はそれより後段だからである。**指示は `完了` でよく、`execution_batch_id` は空欄が正しい**
* **該当 2 件以上** — claim から結果書き戻しまでの間に定期 cron のバッチが割り込むと、同一 host・同一 profile の BATCH が複数並ぶ。この 2 つは host / profile では区別できないため、**帰属を断定せず空欄にする**。誤ったバッチへのリンクを出すより空欄のほうが安全である

`executed_git_ref` はポーラーから `git` を起動して取得しない。**ランナー自身が BATCH レコードへ `git_ref` を記録している**（`runAll.ts` の `git_ref: resolveGitRef(dir)`）ため、上の照合 GET の `fields` に含めれば **API 消費を増やさずに**取得できる。子プロセス起動が 1 つ減り、§8.1 で守るべき攻撃面も減る。照合が空欄になる場合は `executed_git_ref` も空欄とする。

stale 回収は `結果不明` にするだけで再実行しない。ログアプリの `execution_batch_id` と実行指示の時刻を人間が照合し、必要なら新しい指示を追加する。これは at-least-once であって exactly-once ではない。

## 7. kintone REST API と消費回数

使用 API はレコード取得と 1 件更新だけに限定し、アプリ作成・フィールド取得・権限変更 API はランタイムから呼ばない。

| 用途 | HTTP / エンドポイント | 主なパラメータ | 1回のポーリングでの回数 |
| --- | --- | --- | --- |
| 待機・stale 候補取得 | `GET /k/v1/records.json` | `app`, `query`, `fields`。自ホスト、`受付待ち` または期限超過 `実行中`、`order by 作成日時 asc`、有限 `limit` | 常に 1 |
| profile 別の受付上限確認 | `GET /k/v1/records.json` | `app`, `query`, `fields`。候補と同じ host/profile の `受付待ち`、作成日時 asc、有限 `limit` | 候補あり時 1 |
| stale / 期限切れ / overflow 更新 | `PUT /k/v1/record.json` | `app`, `id`, `revision`, 許可された固定 `record` | 対象1件につき1、各設定上限まで |
| claim | `PUT /k/v1/record.json` | `app`, `id`, 取得した `revision`, claim fields | 起動候補1件につき1 |
| 結果書き戻し | `PUT /k/v1/record.json` | `app`, `id`, claim 応答の `revision`, result fields | claim 成功時1 |
| 実行バッチ照合 | `GET /k/v1/records.json`（ログアプリ） | `record_type = BATCH`, `profile`, `host`, `started_at`, order/limit。`fields` は `batch_id` と `git_ref` に限定 | claim 成功かつ Exit 5 以外で最大1 |

ゲストスペースを使う場合だけ `/k/guest/{guestSpaceId}/v1/...` に固定変換する。API トークンは `X-Cybozu-API-Token` ヘッダーで送り、URL、本文、例外、ログへ出さない。

代表的な指示アプリ側の API 消費は次のとおり。

| 経路 | 指示アプリ | ログアプリ | 備考 |
| --- | ---: | ---: | --- |
| 待機、対象なし | 1 | 0 | 5分間隔なら 288回/日 |
| claim 競合 | 3 | 0 | 候補取得 + 上限確認 + 競合する claim PUT |
| 期限切れ | 3 | 0 | 候補取得 + 上限確認 + PUT |
| Exit 0 / 1 / 2 / 3 / 4 | 4 | 1 | 候補取得 + 上限確認 + claim + 結果。別途ランナーの API 消費あり |
| Exit 5 | 4 | 0 | 結果 PUT で `受付待ち` へ戻す |
| stale 1件回収、待機なし | 2 | 0 | GET + PUT |

overflow と stale が同じ回に複数ある場合でも、更新件数は設定上限を超えない。ランナーが resume 中に使う業務アプリ・ログアプリの API は従来どおりであり、ポーラーの表へ混ぜない。

## 8. セキュリティ要件の具体化

### 8.1 argv 配列起動

* 子プロセスは Node の `spawn` を `shell: false` で呼ぶ
* `command`、`args`、`cwd` は検証済みローカル設定からのみ取得し、すべて絶対パスとする
* `args` は第1段階では正確に `--resume` だけを許可する
* `exec`、`execSync`、`sh -c`、テンプレート文字列で作ったコマンドは lint 相当のレビュー検索とテストで禁止する
* **ポーラーが起動する子プロセスは `run_batch.sh` の 1 つだけ**とする。`git` は起動しない（`git_ref` はログアプリの BATCH レコードから取得する — §6.2）

### 8.2 レコード値は allowlist キーだけに使う

* `operation` は `リラン`、`target_host` は設定の自ホスト、`target_profile` は profile map の own key と完全一致した場合だけ受理する
* Unicode 正規化、前方一致、大文字小文字変換、パス結合による「近い値」の受理はしない
* レコードの `request_key`、作成者、文字列を argv、cwd、ファイル名、環境変数名、URL host へ渡さない
* kintone query へ入れる host/profile はローカル設定値だけとし、kintone レコードから再投入しない。クエリ文字列用の引用符・バックスラッシュ拒否も設定検証で行う

### 8.3 stdout / stderr を転記しない

* 子プロセスの `stdio` は `inherit` とし、捕捉・連結・正規表現抽出をしない
* `result_summary` は Exit Code ごとの固定辞書からだけ選ぶ。API エラー本文、例外 stack、SQL、レコード値を含めない
* `execution_batch_id` は stdout から取らず、ログアプリの構造化フィールドを限定 GET して取得する
* `log_url` は設定済み base URL、数値 app ID、検証済み UUID 形式 batch ID からだけ生成する
* ポーラー自身のローカルログもトークンと HTTP Authorization header を出さず、HTTP status、固定分類、指示レコード ID までに制限する

### 8.4 DoS 上限

* 1回のポーリングで起動する子プロセスは最大1件
* profile ごとの `受付待ち` は古い順に `pendingLimit` 件だけを有効とし、超過分は1回あたり `overflowUpdateLimit` 件まで revision 付きで `取消` にする
* 有効期限を超えた指示は実行しない
* stale 回収、overflow 更新、取得 limit、HTTP 応答サイズ、HTTP タイムアウトをすべて有限値にする
* `flock` と kSQL Flow の分散ロックを両方残す。前者はポーラーの多重実行、後者は通常 cron・SSH・ポーラー間のバッチ衝突を防ぐ
* Exit 5 は失敗扱いせず `受付待ち` に戻すが、毎回 `attempt_count` を増やす。指示自体の有効期限を延長しないため、通常バッチが長引いても最後は `期限切れ` になる

### 8.5 その他

* base URL は `https:` のみ許可し、redirect は同一 origin だけ許可するか無効化する
* API 応答は Content-Type、JSON shape、フィールド type、列挙値を検証してから使う
* revision を省略した更新は実装しない。stale、期限切れ、overflow、claim、結果の全更新で取得済み revision を指定する
* kintone 429 / 列挙済み一時障害は、指示の多重実行につながらない GET と PUT 前の通信失敗だけを有限回再試行する。レスポンス喪失後の PUT は成否不明なので無条件再送せず、再 GET で revision と状態を確認する
* SIGTERM / SIGINT では、新規 claim を止める。子が未起動なら claim を `受付待ち` へ戻し、子の起動後なら成功を推測せず stale 回収に委ねる

## 9. cron 登録

#9 の `run_batch.sh` と同じジョブリポジトリ、同じ専用 OS ユーザー、同じ `.env` を使う。通常バッチの cron 行は変更せず、その下にポーラーを追加する。

```cron
7 6 * * * /opt/ksql/my-ksql-jobs/run_batch.sh >> /var/log/ksql/batch.log 2>&1
*/5 * * * * /opt/ksql/my-ksql-jobs/scripts/poll_control.sh >> /var/log/ksql/poll-control.log 2>&1
```

`poll_control.sh` は自身のディレクトリからリポジトリルートを固定的に解決し、`/usr/bin/flock`、`/usr/bin/node --env-file=<固定 .env> <固定 poll_control.mjs> --config <固定 config>` を `exec` する。実際の絶対パスは `command -v node` と `command -v flock` で配備時に確認してからテンプレート値を置換する。

### 9.1 既定は終日ポーリングとする

**ポーリング時間帯を営業時間・平日に絞ってはならない。** この設計が解こうとしている問題は `rerun_trigger_design.md` §1 のとおり **「休日・外出先で、通知は届くのに直せない」** ことであり、平日 7〜20 時限定のポーリングは**その状況でだけ動かない**。

有効期限（§5.2）と組み合わさると失敗する。

* 土曜 9:00 に指示を追加 → 次のポーリングは月曜 7:00
* 既定の有効期限 6 時間は土曜 15:00 に切れている
* 月曜 7:00 のポーラーは `期限切れ` にするだけで、**何も実行しない**

したがって既定は `*/5 * * * *`（終日・288 回/日）とする。指示アプリは専用アプリであり、日次上限（スタンダードコース 10,000 回）に対して **2.9%** なので終日でも余裕がある。

営業時間帯に絞る運用を選ぶ場合は、**有効期限をポーリング空白時間より長く取る**こと（週末を挟むなら 72 時間以上）。この 2 つは独立に設定できてしまうため、§5.2 の起動時検証で整合を強制する。

`poll-control.log` は logrotate 対象にする。ログの正は kintone 側である。

### 9.2 GitHub Actions（#6）との関係

配備先の多くは #6 のワークフローを併用している。

* **ワークフローファイルの変更は不要**（`daily-batch.yml` / `pr-check.yml` とも）
* **復旧目的で Actions を残す必要がなくなる。** #9 では「復旧用に `workflow_dispatch` を残すなら書込可トークンを GitHub Secrets にも置く必要があり、露出面が減るという利点とのトレードオフ」と書いた。本ポーラーがあれば **GitHub には閲覧のみトークンだけ**という構成が完全に成立する（`rerun_trigger_design.md` の案 A は役目を終える）
* **定期実行の主は 1 つに決める。** Actions の `daily-batch` と VPS の cron を両方有効にすると二重スケジュールになる。ポーラーが加わり起動経路は 4 つ（cron・ポーラー・Actions・SSH）になるため、運用手順に明記する。衝突自体はログアプリの分散ロックが Exit 5 で止め、ポーラーは `target_host` でルーティングされるので Actions が指示を拾うことはない
* Actions 側に本ポーラーは載せない。実行環境が使い捨てでポーリングが成立せず、そもそもブラウザからの `workflow_dispatch` がある

## 10. テスト計画

### 10.1 ローカルで確認すること

Node 22 の `node:test` とローカル HTTP モックを使い、実 kintone や実ランナーを必要としない状態機械を網羅する。

* 設定: 未知キー、相対パス、非 HTTPS、未定義 token、allowlist 不一致、範囲外上限を API 前に拒否
* query: host/profile がローカル設定だけから作られ、FIFO、limit、必要 fields が正しい
* 有効期限: 境界直前は claim、境界時刻以後は `期限切れ`
* claim: GET の revision を PUT へ渡すこと、競合エラー時に spawn しないこと
* 起動: `shell:false`、固定 command/cwd、args が `--resume` のみであること。空白・引用符・改行・`../` を含むレコード値でも argv が変わらないこと
* Exit: 0 / 1 / 2 / 3 / 4 / 5、signal、未知 code の状態・固定要約・claim クリアを表どおり検証
* Exit 5: `受付待ち` へ戻り、attempt が増え、有効期限の起点が変わらないこと
* stale: 期限前は触らず、期限後は `結果不明`、自動再起動しないこと
* DoS: profile 上限、1回1起動、overflow/stale/API 取得 limit が設定上限を超えないこと
* 秘密: token、API エラー本文、子 stdout/stderr、悪意あるレコード値が PUT 本文とポーラーログに現れないこと
* 実行バッチ照合: claim より前、別 host/profile、JOB レコードを除外し、**該当 0 件（resume 対象なし）と該当 2 件以上（cron 割り込み）はいずれも空欄で `完了`** すること。`executed_git_ref` も同じ GET から取れ、`git` を起動しないこと
* 設定整合: 指示有効期限がポーリング空白時間以下なら API 呼び出し前に停止すること（§9.1）
* HTTP: timeout、429、5xx、revision 競合、応答喪失、非 JSON、巨大応答、同一 origin 外 redirect
* `flock`: 2プロセスを同時起動して片方だけが API モックへ到達すること

子プロセスは Exit Code だけを返す偽 `run_batch.sh` を一時ディレクトリに置き、kSQL Flow 本体を変更せずに試験する。実装ファイルの静的検索でも `sh -c`、`exec(`、文字列 command、トークン出力、**`git` の起動**がないことを確認する。

### 10.2 VPS 実機でしか確認できないこと

* cron の環境差（cwd、PATH、Node、`.env`）、実行ユーザー、ファイル権限、`flock` の実際の保持
* outbound HTTPS、DNS、TLS、kintone API トークン権限、フィールドアクセス権
* 実 kintone の revision 競合エラーと通知条件
* 通常 cron、ポーラー、SSH 手動実行が kSQL Flow のローカルロック・ログアプリ分散ロックで衝突すること
* v0.4.0 のログアプリに記録された batch ID、as-of 引き継ぎ、git_ref と指示レコードの照合
* cron 自然発火、ポーラー停止時の「受付待ち」滞留通知、logrotate

### 10.3 VPS 実機ドリル

実行指示は `request_key = KSQL_FLOW_TEST_<日時>_<シナリオ>` とする。業務アプリへデータを仕込む場合も、一意キーを `KSQL_FLOW_TEST_` で始め、試験後はその prefix だけを明示抽出して削除する。既存レコードを流用・変更しない。

1. **Exit 0**: `KSQL_FLOW_TEST_EXIT0` の一時障害を解消して指示を追加する。`受付待ち → 実行中 → 完了`、元 as-of 引き継ぎ、batch ID、ログリンク、stdout 非転記を確認する。resume 対象なしの Exit 0 も別に確認する。
2. **Exit 2**: `KSQL_FLOW_TEST_ASSERT` の ASSERT 違反用データを残したまま指示する。`失敗`、Exit 2、書込前停止、固定要約だけを確認する。
3. **Exit 3**: テスト profile のみ到達不能 URLまたは無効なテスト用 token に切り替えて指示する。`失敗`、Exit 3、token/API 本文が指示・ログへ出ないことを確認し、直後に設定を戻す。
4. **Exit 5**: 通常の `run_batch.sh` をテスト用長時間ジョブで保持し、その間にリラン指示を claim させる。指示が `受付待ち` へ戻り attempt が増え、通常実行終了後かつ有効期限内の次回ポーリングで再 claim されることを確認する。
5. **有効期限切れ**: テスト設定だけ有効期限を短くし、古い `KSQL_FLOW_TEST_EXPIRED` を作る。spawn なしで `期限切れ` になることを確認する。
6. **claim 競合**: テスト用の別 lock ファイルを持つ2ポーラーを、同一 host/profile の同じ指示へ同時に向ける。revision PUT は片方だけ成功し、子プロセス起動が1回だけであることをログアプリとモック副作用で確認する。本番 lock を無効化しない。
7. **ポーラー異常終了（子起動前）**: claim 直後で停止できるテストフック版を使い、短い claim 期限後に次のポーラーが `結果不明` へ回収し、自動再実行しないことを確認する。
8. **ポーラー異常終了（子起動後）**: 子実行中にポーラーへ SIGKILL を送り、kSQL Flow 側ログの結果と指示側 `結果不明` を人間が照合できることを確認する。同じ指示の自動再実行は行わない。
9. **ポーラー停止通知**: cron 行を一時コメントアウトし、`受付待ち` が通知閾値を超えたとき kintone 条件通知が届くことを確認して復旧する。
10. **権限**: 依頼者、通知受信者、運用管理者、API token の各主体で 4.2 の許可・拒否を実測する。

テストフックは本番ファイルに隠し環境変数として残さず、試験用コピーまたは依存注入可能なローカルテストハーネスで実現する。実機ドリル後は prefix 検索結果、削除対象 ID、削除後0件を記録する。

## 11. 段階分けと見積り

### 第1段階: ジョブリポジトリのポーラー（MVP）

対象: `my-ksql-jobs`、その後 `ksql-flow-template`。kSQL Flow v0.4.0 は変更しない。

成果物:

* Node 本体、`flock` ランチャー、ポーラー専用設定と設定例
* 実行指示アプリのフィールド・アクセス権・通知設定手順
* ローカル単体/結合テスト、秘密情報検査
* #9 の `run_batch.sh` と同居する cron 例、logrotate 例、運用手順
* `KSQL_FLOW_TEST_` 限定の VPS ドリル記録
* at-least-once、結果不明時の人手照合、有効期限、Exit 5 再受付の運用説明

完了条件:

* Exit 0 / 2 / 3 / 5、有効期限、claim 競合、異常終了を実機で確認する
* kSQL Flow の package、CLI、config schema、ソース、エンジンに差分がない
* 指示レコードから任意の command/argv/cwd を作れず、stdout と秘密が書き戻されない
* 5分間隔の自然発火と滞留通知を確認する

見積り: **3.5〜5人日**。

* 実装・ローカルテスト: 2〜2.5人日
* kintone アプリ構築・権限確認: 0.5〜1人日
* VPS 配備・全ドリル・後片付け: 1〜1.5人日

### 第2段階: `ksql-flow poll-control` 相当の公式サブコマンド化

第1段階の運用実績と API 消費、障害記録をレビューした後、別の仕様裁定と新バージョンで検討する。v0.4.0 MVP には含めない。

移管候補:

* `poll-control` CLI、共通 HTTP/retry/masking、設定バリデーション
* `poll-control init-app` / `--check-control-app` 相当のアプリ作成・契約検査
* 実行指示アプリ ZIP、README、JSON Schema、npm 配布物
* logApp クライアントを使った batch ID の確実な照合
* Linux 以外の起動・排他方式、複数ホスト実行プール
* metrics、heartbeat、運用監視、互換性・移行ポリシー
* help の `poll-control` 追加、Exit Code と設定エラーの公式契約

公式化では「ポーラーが呼ぶ公開済み `run-all --resume` の意味論」は引き続き変えない。`--expect-batch`、`--resume-batch`、自動 resume、通常実行、バックフィルは持ち込まない。

見積り: **4〜7人日 + リリース作業 1人日**。CLI/API 設計 1〜1.5人日、実装・移植 1.5〜2.5人日、テンプレート/ドキュメント 0.5〜1人日、クロス環境・回帰試験 1〜2人日を想定する。複数ホスト対応は別見積りとする。

## 12. 実装順序

1. `poll-control.config.json` の契約と実行指示アプリ定義をレビュー確定
2. HTTP クライアント、応答検証、固定要約、秘密マスキングを実装
3. 候補取得、有効期限、revision claim、DoS 上限、stale 回収を実装
4. argv 配列 spawn、Exit map、ログアプリ照合、結果更新を実装
5. `flock` ランチャーと cron / logrotate を追加
6. ローカル試験を全通過させ、静的な秘密情報・危険 API 検査を実施
7. テスト用実行指示アプリを構築し、VPS の権限・自然発火を確認
8. §10.3 の実機ドリルを順に実施し、prefix 限定で後片付け
9. 実績を `ksql-flow-template` へ反映するかをレビュー
10. 第2段階へ進む場合だけ、公式 CLI の仕様レビューを新規起票

## 13. 未決事項

**無し。**

実装時に値を埋める必要があるホストキー、実行指示アプリ ID、ログアプリ ID、実行時間帯、実際の依頼者グループは配備パラメータまたは運用判断であり、設計裁定を要する未決事項ではない。Q8（自動 resume）、Q9（権限主体）、Q10（手動リランと同一動作）は裁定どおりとし、再提案しない。

## 14. 参照した API 契約

* cybozu developer network「[複数のレコードを取得する](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/)」— `GET /k/v1/records.json`、`app` / `fields` / `query`、最大取得件数
* cybozu developer network「[1件のレコードを更新する](https://cybozu.dev/ja/kintone/docs/rest-api/records/update-record/)」— `PUT /k/v1/record.json`、`id` / `record` / `revision`、revision 不一致時の更新拒否
