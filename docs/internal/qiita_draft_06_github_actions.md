<!--
title: 【kSQL Flow #6】GitHub Actions で kintone バッチをサーバーレス運用 — PR を開くと「書込差分」が自動で貼られる
tags:
  - kintone
  - SQL
  - GitHubActions
  - CICD
-->

> **as-is / no support**: 本ツールは MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証・修正の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、自己責任でお願いします。

- GitHub: https://github.com/rex0220/ksql-flow / テンプレート: https://github.com/rex0220/ksql-flow-template
- 前回: [【kSQL Flow #5】kintone バッチの API 消費を 4 割減らすまで — 「束ねれば速い」が実測で覆った話](https://qiita.com/rex0220/items/9cbc1e0e9b5ab292e6a1)

[#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) は「すでに社内 Windows サーバーがある」層の現実解でした。本記事はその対 — **サーバーを 1 台も持たずに** kintone バッチを毎朝動かします。実行環境は GitHub Actions。[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) でテンプレートから作ったジョブリポジトリに、ワークフローが 2 本**最初から同梱**されています。

この構成の見どころは定期実行そのものより、**PR を開くと kintone への書込差分が自動でコメントされる**ことです。ジョブ SQL のレビューが「SQL を読んで影響を想像する」から「**差分の表を見る**」に変わります。

<!-- TODO: PR コメントのスクリーンショット（実機検証後） -->

## 同梱ワークフローは 2 本

| workflow | トリガー | 内容 |
| --- | --- | --- |
| `daily-batch.yml` | 毎朝 6:07 JST + 手動 | `run-all ./jobs`。手動実行時は `--resume` チェックボックス付き |
| `pr-check.yml` | PR（jobs/・config の変更時） | `validate-all` → `run-all --dry-run --json` → **差分プレビューを PR に自動コメント** |

どちらも**既定では無効**です。リポジトリ変数 `KSQL_ACTIONS_ENABLED = true` を置いたときだけ動きます。

なぜオプトインにしたか — テンプレートから作った直後のリポジトリは Secrets 未設定で、そのまま schedule が発火すると**毎晩失敗して失敗メールが届き続ける**からです。ガードは job レベルの `if` 1 行:

```yaml
jobs:
  run:
    if: ${{ vars.KSQL_ACTIONS_ENABLED == 'true' }}
```

変数未設定のまま発火させると run は `skipped`（緑）で終わります — 実機確認済みです。

## セキュリティ設計 — PR には閲覧のみトークンしか渡さない

CI にトークンを渡すとき、いちばん考えるべきは **「PR 上の SQL はレビュー前のコード」**だということです。AI が生成したジョブも、人間が書いたジョブも、マージ前は信用できません。そこで 2 本のワークフローでトークンを分けます。

| workflow | 渡すトークン | できること |
| --- | --- | --- |
| pr-check | **閲覧のみ**（`*_RO` を同じ環境変数名に注入） | validate と dry-run（書込ゼロの差分プレビュー）だけ |
| daily-batch | 書込可 | main にマージ済みのジョブの本実行 |

```yaml
# pr-check.yml — 同じ変数名に閲覧のみの値を入れる
env:
  KSQL_TOKEN_DEALS: ${{ secrets.KSQL_TOKEN_DEALS_RO }}
  KSQL_TOKEN_CUSTOMERS: ${{ secrets.KSQL_TOKEN_CUSTOMERS_RO }}
  KSQL_TOKEN_LOGS: ${{ secrets.KSQL_TOKEN_LOGS_RO }}
```

[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) の開発機の分離（AI には閲覧のみ・本実行だけ人間の書込トークン）と同じ思想を、CI では「**マージ前 = 閲覧のみ・マージ後 = 書込可**」に写した形です。dry-run は書込ゼロで読取 API しか使わないので、閲覧のみトークンで完結します。

なお **通常、fork からの PR には Secrets は渡されません**（閲覧のみトークンであっても）。private リポジトリでは管理設定で fork PR への Secrets 提供を変えられますが、本構成では「外部のレビュー前コードへ Secrets を渡さない」運用を前提にします。テンプレート推奨どおり private + 同一リポジトリ内ブランチの PR なら影響はなく、public で外部コントリビューションを受ける形にした場合は fork PR の pr-check が失敗またはスキップになります — これは欠陥ではなく、本節と同じ思想の GitHub 側の既定の防御です。

## PR に貼られる差分コメント

pr-check の最終ステップが `run-all --dry-run --json` の出力を整形して PR にコメントします（actions/github-script・追加サービス不要）。ここで登場するトークンは kintone のものではなく **GitHub の `GITHUB_TOKEN`** です — この workflow では最小権限を明示しています:

```yaml
permissions:
  contents: read        # checkout 用
  pull-requests: write  # PR コメント用
```

kintone API トークン（RO/RW）と GitHub 側のトークンは別物なので混同に注意してください。組織設定で `GITHUB_TOKEN` の既定権限を絞っている環境では、この `permissions` 宣言がないとコメント投稿が 403 になります — 宣言しておけば環境差に依存しません。コメントの中身:

<!-- TODO: 実機検証後に実際のコメント Markdown / スクリーンショットに差し替え -->

```
## kSQL Flow dry-run 差分プレビュー（書込ゼロ）

| ジョブ | 結果 | 読取件数 | 書込差分 (+INSERT / ~UPDATE / -DELETE) | API 消費 |
| --- | --- | --- | --- | --- |
| monthly_deal_summary.sql | SUCCESS | 2,000 | 顧客管理: +0 / ~200 / -0 | 10 |
```

レビュアーが見るのは「この PR をマージして毎朝動くと、**どのアプリに何件書くのか**」です。SQL の意図はコードレビューで、影響範囲はこの表で、と分担できます。

## schedule の正直な制約 — cron が「6:07」である理由

GitHub Actions の schedule は**ベストエフォート**です。実行時刻は保証されず、混雑時は遅延し、まれにスキップもあり得ます。ワークフローの cron が `7 21 * * *`（= 6:07 JST）と半端なのは、**毎時 0 分が最も混雑して遅延しやすい**ためのずらしです。

それでも kSQL Flow のジョブが壊れないのは、集計基準が**開始時刻ではなく as-of**（バッチ開始時に固定される基準時刻）だからです。6:07 に動いても 6:40 に動いても「今月分の集計」は同じ結果になります。時刻厳守が要件なら、schedule ではなく [#4 のタスクスケジューラ](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4)や cron を選んでください。

そのほかの注意:

- cron は **UTC 表記**です（JST - 9 時間。6:07 JST = 21:07 UTC）
- **public リポジトリは 60 日間更新がないと schedule が自動無効化**されます（テンプレートの推奨どおり private なら対象外）
- まれな二重発火は、ログアプリの分散ロック（Exit 5）が吸収します — スケジューラが何であっても運用装備は同じ、が連載の主張です

## 失敗したら — 通知は kintone、リランは workflow_dispatch

失敗通知に Actions 側の仕掛けは**不要**です。[#4 で組んだ kintone 標準の条件通知](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4)（ログアプリに 2 条件）は、**実行環境がどこであっても同じように働きます** — ランナーがログアプリに FAILED 系レコードを書いた瞬間に通知が飛ぶ仕組みだからです。スケジューラを乗り換えても通知・記録・排他・復旧が変わらない、これが「運用装備はランナーが持つ」設計の配当です。

復旧は Actions の画面から: daily-batch の「Run workflow」に **resume チェックボックス**を付けてあります。ON で実行すると `run-all --resume` になり、前回失敗分だけを**元の as-of を引き継いで**再実行します（自動リトライを仕掛けない理由は #4 と同じ — 業務異常は再実行しても直りません）。

チェックボックスの実装はこれだけです — `workflow_dispatch` の boolean input を、式で CLI 引数に展開します:

```yaml
on:
  schedule:
    - cron: '7 21 * * *'   # 21:07 UTC = 翌朝 6:07 JST（0 分を避ける）
  workflow_dispatch:
    inputs:
      resume:
        description: "前回失敗分のみ再実行（--resume・元の as-of を引き継ぐ）"
        type: boolean
        default: false
# ...
      - name: run-all
        run: npx --no-install ksql-flow run-all ./jobs --profile prod ${{ inputs.resume == true && '--resume' || '' }}
```

schedule 起動時には `resume` が指定されないため、この構成では通常実行になります。

<!-- TODO: 実機検証後に記入 —
## 実機検証の記録
- daily-batch 手動発火 → SUCCESS・ログアプリ BATCH/JOB 記録・所要時間
- schedule 自然発火（6:07 設定のまま 1 晩）→ 実際の起動時刻（遅延の実測）
- テスト PR → validate + dry-run コメントのスクリーンショット
- 失敗系: notify_test を含む PR → Exit 2 で checks が赤くなること・コメントに ABORTED が出ること
- resume 実行の記録
-->

## 有効化手順（テンプレート利用者向け・3 分）

リポジトリの Settings → Secrets and variables → Actions で:

1. **Variables**: `KSQL_ACTIONS_ENABLED` = `true`
2. **Secrets**: 書込可 3 つ（`KSQL_TOKEN_DEALS` / `KSQL_TOKEN_CUSTOMERS` / `KSQL_TOKEN_LOGS`）+ 閲覧のみ 3 つ（`*_RO`）

CLI 派なら `gh variable set` / `gh secret set` で同じことができます。トークン値は書込可を含むので、扱いは #4 のサーバー `.env` と同格 — GitHub の Secrets は暗号化保存・ログ自動マスクですが、リポジトリの管理権限を持つ人が実行内容を変えられる点は意識してください（保護ブランチ + 必須レビューで main へのマージを守るのがセットです）。

## まとめ

- テンプレートに同梱の 2 ワークフローで、**サーバーゼロ**の毎朝実行と **PR への差分自動コメント**が手に入る
- トークンは「マージ前 = 閲覧のみ / マージ後 = 書込可」で分離 — レビュー前の SQL に書込権限を渡さない
- schedule はベストエフォート。**as-of 基準の集計だから遅延に強い**（時刻厳守なら #4 へ）
- 通知・記録・排他・復旧はランナー + kintone 側の装備がそのまま効く — スケジューラは今回も「決まった時刻に 1 コマンド叩く装置」
- 既定無効のオプトイン設計（未設定なら skipped で緑 — 実機確認済み）

## 連載

1. **#1**: [kintone のバッチ処理を SQL 1 本で書けるランナーの紹介](https://qiita.com/rex0220/items/893ab4016a5aaf595642)
2. **#2**: [AI エージェントに kintone のバッチジョブを書かせる — MCP + Claude Code](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa)
3. **#3**: [毎朝の無人実行の前に — kintone バッチを 200 → 20,000 → 100,000 件で鍛える](https://qiita.com/rex0220/items/62e950ab1ccc5b54ff69)
4. **#4**: [タスクスケジューラで毎朝動かす — PowerShell が 0.1 秒で無言死する罠つき](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4)
5. **#5**: [kintone バッチの API 消費を 4 割減らすまで — 「束ねれば速い」が実測で覆った話](https://qiita.com/rex0220/items/9cbc1e0e9b5ab292e6a1)
6. **#6（本記事）**: GitHub Actions で kintone バッチをサーバーレス運用
7. 以降、cron・Docker / レンタルサーバー / Google Cloud の環境別と、排他・冪等リランの設計深掘りを予定
