<!--
title: 【kSQL Flow #2】AI エージェントに kintone のバッチジョブを書かせる — MCP + Claude Code
tags:
  - kintone
  - SQL
  - MCP
  - AIエージェント
-->

<!-- TODO: 第1話の公開後、以下のリンクを実 URL に差し替え -->

> **as-is / no support**: 本ツールは MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証・修正の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、自己責任でお願いします。

- GitHub: https://github.com/rex0220/ksql-flow （ランナー） / https://github.com/rex0220/kintone-sql-tools （エンジン + MCP） / https://github.com/rex0220/ksql-flow-template （本記事のテンプレート）
- 前回: 【kSQL Flow #1】kintone のバッチ処理を SQL 1 本で書けるランナーの紹介

## 前回のおさらいと、今回やること

第1話では、kintone のバッチ処理（案件管理 → 顧客管理の月次集計）を SQL ファイル 1 本で定義し、kSQL Flow が排他・ログ・リラン・リトライを引き受ける構成を紹介しました。

今回はそのジョブ SQL を、**要件文から AI エージェントに書かせます**。

ポイントは役割分担です。

| 役割 | 担当 |
| --- | --- |
| 生成（スキーマ確認・SQL 作成・手直し） | AI エージェント + kSQL MCP |
| 検証（構文・スキーマ・安全ルール） | 機械（validate の二段構え） |
| 最終判断（この差分を本番に流してよいか） | 人間（dry-run レビュー） |

「AI が書いたコードを信用できるか」という問いに、**信用しなくて済む仕組みで答える**構成です。AI の善意や賢さではなく、実行系の検査で守ります。

```mermaid
flowchart LR
    REQ["要件文<br/>（日本語）"] --> AI["AI エージェント<br/>+ kSQL MCP<br/>スキーマ確認 → SQL 生成<br/>→ 一次検証(ksql_validate)"]
    AI --> JOB["jobs/*.sql<br/>（ジョブファイル）"]
    JOB --> VAL["ksql-flow validate<br/>実行環境でフル検証"]
    VAL --> DRY["ksql-flow run --dry-run<br/>差分プレビュー = 人間の最終レビュー"]
    DRY -->|"承認"| GIT["Git へコミット<br/>= 運用資産"]
    GIT -.->|"次回: スケジューラで毎朝実行"| OPS["定期実行"]
```

## なぜ AI との共通言語が SQL なのか（30 秒版）

エンジン側の記事「[AIエージェントにkintoneを操作させるにはSQLが最適解である](https://qiita.com/rex0220/items/fbed33b11251cdf7e31e)」で詳しく書いた話の要点だけ:

1. **SQL は LLM が最も得意なデータ操作言語。** JOIN・GROUP BY の説明は不要
2. **1 文 = 1 意図。** 生成物を実行前に人間が読んでレビューできる
3. **実行はサーバー側で完結。** 生レコードが AI のコンテキストを通らない

そして第1話で紹介したジョブの構文 — `ASSERT`（業務異常で停止）、`EXIT SUCCESS IF`（対象なしは正常スキップ）、キー指定 `UPSERT`（冪等）— は、**AI が書いても安全側に倒れるための言語ガード**でもあります。ガードが言語に入っていれば、AI がガードを「書き忘れた」ことも機械検査で分かります。

## 準備: VSCode + Claude Code + kSQL MCP

第1話から引き継ぐのは **kintone 側の構成だけ**です（営業支援パック + 追加 3 フィールド + 実行ログアプリ + 各アプリの API トークン）。作業ディレクトリは第1話のものを使い回さず、**AI 協働用のテンプレートリポジトリから新しく作り**、VSCode で開いて Claude Code を使います。第1話が「手元で最小構成を動かす」ためのセットアップだったのに対し、こちらは Git 管理と AI 協働を前提にした構成です。この構成にする理由は 3 つ:

- ジョブ SQL・ランナー config・MCP 設定が **1 つのリポジトリに揃い、そのまま Git 管理**できる
- エージェントが **MCP（スキーマ確認・下見クエリ）とターミナル（`ksql-flow validate` / `--dry-run`）の両方**を使える
- 生成 → 検証 → 差分レビュー → コミットが 1 画面で完結する

（Claude Desktop や他の MCP 対応エージェントでも考え方は同じです。その場合の MCP 登録手順はエンジン側リポジトリの `docs/ksql_mcpb_claude_desktop_install.md` を参照してください）

この構成一式は**テンプレートリポジトリ**として公開しています。GitHub の「Use this template」で自分のリポジトリを作って clone すれば、以下が揃った状態から始められます。

- https://github.com/rex0220/ksql-flow-template

```text
├── CLAUDE.md                 # AI 向けの作業規約（後述 — この構成の核）
├── .mcp.json                 # Claude Code の MCP 登録（開くだけで kSQL MCP がつながる）
├── package.json              # 依存（ランナー + エンジン/MCP）と npm scripts
├── ksql.config.json          # ランナー用の接続設定 — トークンは env: 参照
├── ksql.mcp.config.json      # MCP 用の接続設定 — 閲覧のみトークン
├── .env.example              # トークンの置き場所の雛形（.env は .gitignore 済み）
└── jobs/
    └── monthly_deal_summary.sql   # 検証済みサンプルジョブ
```

### 環境構築（初回 15 分）

前提: Node.js 20.6+ / VSCode + Claude Code / 第1話のアプリ構成（営業支援パック + 追加 3 フィールド + 実行ログアプリ）。グローバルインストールは不要で、ランナーも MCP サーバーもリポジトリ内に入ります。

**1. テンプレートから自分のリポジトリを作る** — テンプレートページ右上の「Use this template → Create a new repository」。設定にアプリ ID や業務用語が入るので **Private で作成**します（visibility は Public が初期値なので注意）。GitHub CLI なら 1 行:

```bash
gh repo create my-ksql-jobs --template rex0220/ksql-flow-template --private --clone
```

**2. 依存を入れる** — ランナーとエンジン + MCP サーバーが入ります。これだけです。

```bash
cd my-ksql-jobs && npm install
```

**3. 実行ログアプリを作る** — 第1話で作成済みならそのまま。未作成なら kSQL Flow 同梱の[アプリテンプレート](https://github.com/rex0220/ksql-flow/tree/main/template)から約 3 分です。

**4. 接続設定を書き換える** — `ksql.config.json`（ランナー用）と `ksql.mcp.config.json`（MCP 用）の `baseUrl` とアプリ `id` を自環境に合わせます。トークン値はこの 2 ファイルには書きません。

**5. トークンを置く** — `.env.example` をコピーして `.env` を作り、**閲覧のみトークン**を貼ります（分離の設計は後述）。

**6. VSCode で開いて Claude Code を起動** — 初回に kSQL MCP サーバーの使用可否を聞かれるので許可します（登録内容は `.mcp.json`）。

**7. 疎通確認** — Claude Code に「`ksql_describe_app` で `LAPP_案件管理` のフィールド一覧を見せて」と指示し、フィールドコードと型が返ってくれば準備完了。

![2026-08-22_21h35_19.png](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/100572/af06939d-7fc1-4e92-90c3-eafd01599e86.png)

ターミナル側は `npm run check-logapp -- --profile prod` でログアプリの定義検査まで通ります。

```
my-ksql-jobs  [main ≡ +0 ~2 -1 !] > npm run check-logapp -- --profile prod

> ksql-flow-template@1.0.0 check-logapp
> node --env-file=.env node_modules/@rex0220/ksql-flow/dist/cli.js validate --check-logapp --profile prod

OK: ログアプリ (ID 4249) は 8.2 のフィールド定義を満たしています
```

設計上のポイントを 1 つだけ — テンプレートでは **MCP 側の `logicalApps` の論理名を、ランナー config の `apps` と同じ名前にしてあります**。こうすると、AI が対話中に書く `LAPP_案件管理` という表記が、**MCP での下見クエリと kSQL Flow のジョブでそのまま同じ意味になります**。生成した SQL を書き換えずにジョブファイルへ移せる、というのがこの構成の要です。

### AI に kSQL Flow の知識を与える — CLAUDE.md と ksql_docs

ここが今回の構成でいちばん重要な部分です。kSQL Flow は公開して間もない OSS なので、**LLM は学習データとしてほとんど知りません**。何もしなければ、エージェントは「それらしい構文」を発明します。この穴は 2 つの仕組みで塞ぎます。

1. **方言仕様の一次資料は MCP の `ksql_docs`。** kSQL の言語リファレンスには Flow 拡張構文（dialect 1: ディレクティブ・`ASSERT`・`EXIT SUCCESS IF`・`@` 付き時刻関数）の章とレシピがあり、エージェントが章単位で取得できます。構文は覚えているものを書くのではなく、**その場で引かせます**
2. **作業規約はリポジトリの `CLAUDE.md`。** Claude Code はリポジトリ直下の `CLAUDE.md` を毎セッション自動で読み込みます。テンプレートには、作成手順（スキーマ確認 → `ksql_docs` で方言確認 → 下見 → 生成 → 二段の validate → dry-run）、ジョブ規約（`@` 付き時刻関数・`ASSERT` と `EXIT SUCCESS IF` の使い分け・キー指定 UPSERT）、してはいけないこと（**本実行しない・構文を推測で書かない**）を記した [CLAUDE.md](https://github.com/rex0220/ksql-flow-template/blob/main/CLAUDE.md) が入っています

つまり「AI が kSQL Flow を知らない」ことは前提であって、**知識は Git 管理された規約ファイルと MCP のドキュメントツールで毎回与える**設計です。規約を直せば AI の振る舞いも変わり、その変更履歴も Git に残ります。

### トークンは「閲覧のみ」と「書込可」を分ける

この構成の安全性はトークンの分離で担保します。kintone の各アプリで**閲覧のみのトークン**と**書込可のトークン**を別々に発行し、置き場所を分けます。

| 置き場所 | トークン | できること |
| --- | --- | --- |
| `.env`（`.env.example` をコピーして作成・Git 管理外） | 閲覧のみ | MCP のスキーマ確認・下見クエリ、`npm run validate` / `npm run dry-run` |
| 本実行する人間の OS 環境変数（`setx` 等） | 閲覧 + 編集（+ 追加） | `npm run job`（本実行） |

MCP サーバーも npm scripts も Node の `--env-file=.env` 経由で動き、**OS の環境変数は `.env` より優先**されます。つまり `.env` は閲覧のみのまま置いておけて、書込可トークンを OS 環境変数に設定した人間のターミナルでだけ本実行が通ります（Windows の `setx` で設定した場合、反映には **VSCode の全ウィンドウを閉じての再起動**が必要です — Reload Window では反映されません）。**AI は validate と dry-run まで自走できますが、物理的に kintone へ書き込めません**。運用ルールではなく構成で守ります。

## 要件文からジョブを作らせる

エージェントへの依頼は、業務要件をそのまま日本語で書きます。

> 案件管理アプリから「当月受注予定」の案件を会社別に集計して、顧客管理アプリの `当月案件件数`・`当月売上合計`・`最終集計日時` を更新する kSQL Flow のジョブ（dialect 1）を書いてください。
>
> - マイナスの売上データがあれば異常として何も書かずに停止
> - 対象が 0 件の月は正常スキップ（アラートを鳴らさない）
> - 何度実行しても同じ結果になること（冪等）
> - スキーマは思い込みで書かず、MCP で実際に確認してから書くこと

最後の 1 行が実務上いちばん効きます。エージェントはまず `ksql_describe_app` でフィールドコードと型を取得し（ここで `受注予定日` が DATE、`売上` が NUMBER だと確定します）、`ksql_query` で件数確認の下見 SELECT を流し、それからジョブを書きます。仕様が曖昧な構文は `ksql_docs` で言語リファレンスを引かせれば、構文の発明も防げます。

こうして実際に生成されたジョブの全文がこちらです。第1話で紹介したジョブと同じ構成（ASSERT → 集計 → EXIT SUCCESS IF → キー指定 UPSERT）に到達しました。一時テーブル名や列の別名といった細部は生成のたびに揺れますが、そこは検証とレビューで守られる範囲です（テンプレート同梱のサンプルジョブは、この実走版に更新してあります — 初回は生成させずにサンプルで流れを確認する、でも構いません）。

```sql
-- @ksql name: monthly_deal_summary
-- @ksql timeout: 600
-- @ksql dialect: 1

-- 当月受注予定（受注予定日が当月内）の案件を会社別に集計し、
-- 顧客管理の 当月案件件数・当月売上合計・最終集計日時 を更新する。
-- as-of 注入（/flow の asOf）で過去月のバックフィルも同一スクリプトで再現可能。

-- 1) 業務異常ゲート: マイナス売上があれば何も書かずに中断（アラート対象）
ASSERT (
  SELECT COUNT(*) FROM LAPP_案件管理
  WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
    AND 売上 < 0
) = 0, '【異常中断】当月受注予定の案件にマイナスの売上データが存在します';

-- 2) 会社別に集計（インメモリ・書込 API 消費なし）
CREATE TEMP TABLE summary AS
SELECT 会社名,
       COUNT(*) AS 当月案件件数,
       SUM(売上) AS 当月売上合計
FROM LAPP_案件管理
WHERE 受注予定日 >= @MONTH_START() AND 受注予定日 < @NEXT_MONTH_START()
GROUP BY 会社名;

-- 3) 対象 0 件の月は正常スキップ（アラートなし）
EXIT SUCCESS IF (SELECT COUNT(*) FROM summary) = 0,
  '当月受注予定の案件が 0 件のためスキップ';

-- 4) 冪等な書き込み: 会社名（重複禁止）をキーに UPSERT
UPSERT INTO LAPP_顧客管理 (会社名, 当月案件件数, 当月売上合計, 最終集計日時)
SELECT 会社名, 当月案件件数, 当月売上合計, @NOW()
FROM summary
KEY (会社名);
```

これを `jobs/monthly_deal_summary.sql` に保存し、検証まで自走させたときの **Claude Code の結果報告（実物・体裁のみ整形）** がこちらです。アプリ ID 4246/4247 は検証環境の実 ID です（記事中の config 例では 100/200 に置き換えています）。

### Claude Code の結果報告（実物）

**スキーマ実測（`ksql_describe_app`）**

- 案件管理（4247・26 フィールド）: `受注予定日` DATE / `売上` NUMBER / `会社名` SINGLE_LINE_TEXT（ルックアップ）を確認
- 顧客管理（4246・24 フィールド）: `会社名` が重複禁止 → UPSERT キーに採用

**データ下見（`ksql_query`）**

| 項目 | 値 |
| --- | --- |
| 案件管理 総件数 | 276 件 |
| 受注予定日 入力あり | 16 件（最新 2025-12-26） |
| 当月（2026-08）対象 | **0 件** |
| マイナス売上 | 0 件 |
| 当月対象の会社名空値 | 0 件 |

**検証**

| 段階 | 結果 |
| --- | --- |
| 一次検証 `ksql_validate` | OK（診断なし） |
| 二次検証 `npm run validate -- -f jobs/monthly_deal_summary.sql --profile prod` | OK |
| dry-run `npm run dry-run -- ... --profile prod` | 当月 0 件のため `EXIT SUCCESS`（NO_DATA・exit 0）。読取 API 4 回・書込 0 件 |
| 書き込み経路の `VALIDATE ONLY`（2025-12 条件・書込 API 消費なし） | **失敗** — `DML target field 当月案件件数 does not exist` |

**要対応（ブロッカー）** — 顧客管理アプリに書き込み先フィールドが存在しない。以下を**フィールドコードをこの名前どおり**に追加すること:

| フィールドコード | タイプ |
| --- | --- |
| 当月案件件数 | 数値 |
| 当月売上合計 | 数値 |
| 最終集計日時 | 日時 |

**既知の挙動（仕様どおりだが注意）** — 0 件月はスキップするため、**月が変わっても前月の集計値は残る**（ゼロクリアしない。当月に案件のない会社の値も前回のまま）。全顧客を毎回 0 リセットしたい場合は、マスタ起点 LEFT JOIN 方式への変更で対応可能。

### 検査がブロッカーを見つけ、AI が「人間への要求」を出した

実はこの時点で、検証環境の顧客管理には書き込み先の 3 フィールドをまだ追加していませんでした。注目してほしいのは**検出のされ方**です。

- ランナーの validate は**通っています**（UPSERT の書込先「列」の存在は validate の守備範囲外 — キーの検査とは別）
- 当月対象が 0 件のため、通常の dry-run も `EXIT SUCCESS IF` で正常終了し、**書込経路まで届きません**
- そこで AI は、下見で見つけた過去月（2025-12）の条件で **`VALIDATE ONLY`**（1 件も書き込まずに全行検証するエンジン機能）を流して書込経路そのものを検査し、フィールド不存在を検出しました

そして AI にできるのはここまでです。**kSQL はデータの読み書き専用で、アプリのフォーム変更はできません。** だから報告の結論は「要対応: この 3 フィールドを追加すること」という**人間への要求**になります。ジョブは書けるがアプリ構造には手が届かない — この分離も、閲覧のみトークンと同じく構成で決まっている境界です。


## フィールドを追加して、本実行まで

要求どおり 3 フィールドを kintone のフォームに追加し（人間の作業・約 1 分）、Claude Code に再検証させました。報告の要点:

- **スキーマ実測**: 顧客管理に `当月案件件数`（NUMBER）・`当月売上合計`（NUMBER）・`最終集計日時`（DATETIME）が正しいフィールドコードで追加されたことを `ksql_describe_app` で確認
- **書き込み経路の `VALIDATE ONLY`**（データのある 2025-12 条件・書込 API 消費なし）: 前回失敗していた箇所が**エラー 0 で通過**
- **二次検証** `npm run validate -- --profile prod`: OK
- **dry-run**: 当月（2026-08）は対象 0 件のため NO_DATA（exit 0）で正常スキップ・書込 0 件

締めの報告はこうでした（実物）:

> 再検証はすべて OK です。ブロッカーは解消され、ジョブは本実行可能な状態になりました。あとは本実行のみで、こちらはご自身のターミナルでお願いします。今月は 0 件スキップ（exit 0）になる想定です。

最後の一文まで含めて役割分担どおりです。人間のターミナル（書込可トークンを OS 環境変数に設定してある側）で本実行:

```
my-ksql-jobs  [main ≡ +0 ~2 -1 !] > npm run job -- -f jobs/monthly_deal_summary.sql --profile prod

> ksql-flow-template@1.0.0 job
> node --env-file=.env node_modules/@rex0220/ksql-flow/dist/cli.js run -f jobs/monthly_deal_summary.sql --profile prod

[RUN] monthly_deal_summary.sql (profile: prod, as-of: 2026-08-22T13:08:22.143Z)
  => NO_DATA (exit 0) 読取 0 件 / 書込 0 件 / API 5 回
```

AI の宣言どおり NO_DATA（exit 0）で着地しました。アラートは鳴らず、実行ログアプリには NO_DATA の 1 レコードが残ります。「対象がない月は静かに成功する」（第1話の設計ポイント①）が、AI の書いたジョブでもそのまま機能した形です。集計経路を実データで動かしたい場合は、`--as-of "2025-12-01T00:00:00+09:00"` を付けてバックフィル実行すれば、2025-12 分の UPSERT が走ります。

## 機械の検査が AI のミスを捕まえる（実例）

「AI は間違える」前提で、どの間違いがどこで捕まるかを実際に試した結果です。

**時刻関数の `@` を付け忘れた場合** — `@MONTH_START()` の代わりに `THIS_MONTH()` と書くと、`ksql-flow validate` が警告します。

```
monthly_deal_summary.sql: OK (警告 2 件)
  monthly_deal_summary.sql:10:1 warning KSQL1306 bare の時刻依存関数は kintone サーバー評価の
  ため as-of の対象外です。再現性が必要なら @ 付き関数を使用してください。
  monthly_deal_summary.sql:17:1 warning KSQL1306 （同上）
```

これは第1話の設計ポイント②（時刻はバッチ開始時に固定）を機械が守らせている、ということです。

**UPSERT のキーを間違えた場合** — 顧客管理に存在しない `顧客名` をキーに書くと、エラーで止まります。

```
monthly_deal_summary.sql: NG (エラー 1 件 / 警告 0 件)
  monthly_deal_summary.sql:30:1 error KSQL1302 UPSERT / MERGE のキー「顧客名」が
  APP200 のフォームに存在しません。重複禁止を設定した文字列（1行）または
  数値フィールドをキーにしてください。
```

キーに重複禁止が設定されていない場合も、同系統の検査（KSQL1303）で止まります。冪等リランの前提が崩れる書き込みは、実行前に拒否されます。

**WHERE のフィールド名を間違えた場合** — `受注予定日` を `受注日` と書いた場合、これは validate では捕まりません（絞り込み条件は kintone 側で評価されるため）。ただし放置されるわけではなく、二重の網があります。まず AI に「MCP で確認してから書く」手順を踏ませていれば、`ksql_describe_app` と下見クエリの時点で露見します。それでもすり抜けた場合は、**dry-run の読み取り段階で kintone への問い合わせが解決できず、書き込みゼロのまま停止**します。

```
エラー内容: ArgumentError: WHERE predicate is unsupported
  (field=受注日, operator=>=, reason=WHERE_FIELD_UNRESOLVED).
```

「どの検査が何を守るか」を知っておくと、AI への指示も検証の運用も設計できます。

## 検証は二段構え

生成した場所（AI との対話）と実行する場所（バッチの実行環境）は別物です。だから検証も二段にします。

| 段階 | コマンド / ツール | 見るもの | いつ |
| --- | --- | --- | --- |
| 一次 | MCP `ksql_validate` | 構文・dialect 1 のルール・MCP 設定でのスキーマ | AI との対話中（即時） |
| 二次 | `npm run validate`（ランナーの validate） | **実行環境の** config・トークン・実スキーマ（UPSERT キーの実在と重複禁止まで） | ジョブファイル保存後 |

一次検証は MCP 経由で対話の中で終わります。二次検証は「実行環境でも同じ結論になるか」の確認で、VSCode + Claude Code 構成なら**これも AI がターミナルで実行し、結果を読んで自分で直すところまで自走**できます。MCP の設定と実行環境の config が食い違っていた（アプリ ID が違う等）というズレは、ここで出ます。

```bash
npm run validate -- -f jobs/monthly_deal_summary.sql --profile prod
```

## dry-run が人間の最終レビュー

最後の関門は機械ではなく人間です。ただしレビュー対象は SQL の字面ではなく、**「実行したら実際に何が起きるか」の差分**です。dry-run は閲覧トークンで動くので、ここまでは AI が実行して結果を会話に貼るところまで自走できます。

```bash
npm run dry-run -- -f jobs/monthly_deal_summary.sql --profile prod
```

今回の実走は 0 件月だったので差分なしの正常スキップでしたが、対象がある月にはこんな差分が出ます（出力例）:

```
[DRY-RUN] monthly_deal_summary.sql (as-of: 2026-08-22T00:00:00.000Z)
  読み取り        : 276 件（API 5 回）
  書き込み予定    : LAPP_顧客管理  INSERT 1 件 / UPDATE 1 件 / DELETE 0 件
  変更サンプル（先頭 5 件）:
    会社名=山田商事  当月売上合計: 1,200,000 → 1,450,000
    会社名=鈴木建設  (新規) 当月売上合計: 380,000
  => dry-run 完了（kintone 書き込み 0 件）
```

「山田商事が 145 万に更新され、鈴木建設が新規で入る。件数は 2 件」— この粒度なら、SQL を読めない人でも承認判断ができます。`ASSERT` や `EXIT SUCCESS IF` の判定は dry-run でも本実行と同じに効くので、業務異常があればこの段階で Exit 2 で止まります。

問題なければ、人間が**自分のターミナル**（書込可トークンを OS 環境変数に設定してある側）で本実行します。AI に本実行させないのは運用ルールではなく構成です — AI 側の `.env` には書き込めるトークンがありません。

```bash
npm run job -- -f jobs/monthly_deal_summary.sql --profile prod
```

## ジョブは Git へ — AI の成果物を運用資産にする

出来上がった `jobs/monthly_deal_summary.sql` はただのテキストファイルなので、そのままコミットして PR でレビューできます。VSCode + Claude Code 構成なら、ジョブも config も MCP 接続設定（`.mcp.json`）も同じリポジトリにあるので、**「AI がジョブを書いた」という出来事の全体が Git の履歴に残ります**。会話ログと違って、**AI 抜きで再実行・再検証できる資産**です。`validate` と `dry-run` は CI にも組み込めます（PR に dry-run の `--json` 出力を貼るレシピは GitHub Actions 編で扱う予定です）。

まとめると、この構成の信頼モデルはこうなります。

- AI は**閲覧のみトークン**でジョブを作り、validate・dry-run まで自走する（書込トークンを持たない）
- 機械は**二段の validate** で構文・スキーマ・安全ルールを検査する
- 人間は **dry-run の差分**という「読める形」で最終判断し、本実行だけを自分の手で行う

## 次回

このジョブを **Windows タスクスケジューラで毎朝動かします**。実機検証で踏んだ「PowerShell が 0.1 秒で無言死する罠」を含む運用編です。

## 今後の連載予定

1. **#1**: kintone のバッチ処理を SQL 1 本で書けるランナーの紹介
2. **#2（本記事）**: AI エージェントにジョブを書かせる（MCP + 二段 validate + dry-run レビュー）
3. **#3**: タスクスケジューラで毎朝動かす — 実機で踏んだ罠 2 連発つき
4. 以降、GitHub Actions / cron・Docker / AWS / Azure / GCP の環境別と、排他・冪等リランの設計深掘りを予定
