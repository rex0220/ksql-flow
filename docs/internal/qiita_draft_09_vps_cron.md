<!--
title: 【kSQL Flow #9】月 1,000 円の VPS で kintone バッチを毎朝動かす — cron の遅延は 1 秒だった
tags:
  - kintone
  - SQL
  - VPS
  - cron
  - Ubuntu
-->

> **as-is / no support**: 本ツールは MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証・修正の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、自己責任でお願いします。

- GitHub: https://github.com/rex0220/ksql-flow / テンプレート: https://github.com/rex0220/ksql-flow-template
- 前回: [【kSQL Flow #8】バッチの失敗は 4 種類ある — 自動リラン・AI 診断・人間の判断の切り分け](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a)

実行環境の 3 本目です。[#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) は「**すでに社内 Windows サーバーがある**」層、[#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) は「**サーバーを持ちたくない**」層でした。本記事はその中間 — **月 1,000 円の VPS を 1 台借りて、毎朝正確な時刻に動かす**構成です。

そして今回、連載でずっと引きずってきた宿題に答えが出ました。#6 で GitHub Actions の schedule が **+30〜99 分**遅れることを実測し、「時刻厳守なら cron を」と書きましたが、その cron が**実際どれだけ正確なのか**は測っていませんでした。

結論を先に書きます。**予定 16:25:00 に対して、実際の起動は 16:25:01。遅延 1 秒でした。**

環境は ConoHa VPS（1GB / 2Core・月 1,064 円）+ Ubuntu 24.04 LTS。**素の状態から通しでセットアップし、失敗と復旧まで検証**しています。そして例によって、その過程で罠を 5 つ踏みました。

## なぜ VPS か — 3 つの選択肢の中での位置づけ

| | [#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) Windows サーバー | [#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) GitHub Actions | **#9 VPS + cron** |
| --- | --- | --- | --- |
| 前提 | 社内サーバーが既にある | サーバー不要 | **月 1,000 円で 1 台借りる** |
| 時刻の正確さ | 正確（#4 で実測 +0 分） | **+30〜99 分の遅延** | **正確（実測 +1 秒）** |
| 運用の手間 | OS 管理は既存の情シス | ほぼゼロ | **自分で OS 管理**（更新・監視） |
| PR 検証 | なし | あり | GitHub Actions と**併用可**（後述） |

VPS が向くのは「**社内サーバーは無い・時刻は正確に・自分で管理できる**」ケースです。逆に、時刻が多少ずれてもよいなら #6 のほうが管理コストゼロで優れています。ここは正直に選んでください。

なお「共有レンタルサーバーではどうか」もよく聞かれます。SSH と cron が使えるプランはありますが、**OS・Node.js の導入方法・Docker の可否・権限や通信の制約が VPS と異なるため、本記事の手順をそのまま適用する用途には向きません**。たとえばさくらのレンタルサーバは FreeBSD で Node.js の公式バイナリが無く（ソースからのコンパイル等が必要）、Docker も使えず、国外 IP アドレスフィルターの設定によっては GitHub など海外サービスとの連携に追加設定が要ります。

しくみの全体像は 1 枚にするとこうです（#4・#6 と見比べると、**サーバーの箱が入れ替わっただけで kintone 側は同一**であることが分かります）:

```mermaid
flowchart TB
    subgraph dev["開発機 — my-ksql-jobs の clone（#2 の構成）"]
        AI["VSCode + Claude Code<br>ジョブ作成 → dry-run"]
    end
    REPO["GitHub — あなたの my-ksql-jobs（private）<br>PR で pr-check だけ動かす構成も可"]
    subgraph vps["VPS（Ubuntu 24.04・月 1,000 円）"]
        CRON["cron<br>毎朝 6:07 JST・遅延 1 秒"]
        SH["run_batch.sh<br>cd \"$(dirname \"$0\")\" 基準"]
        RUN["ksql-flow run-all<br>トークンは .env（chmod 600）"]
        UPG["unattended-upgrades<br>更新は自動・再起動は要設定"]
        CRON --> SH --> RUN
        RUN -.->|"Exit Code をそのまま返す"| CRON
    end
    subgraph kin["kintone"]
        APPS["業務アプリ<br>読取・書込"]
        LOG["実行ログアプリ<br>BATCH / JOB・分散ロック"]
        NTF["条件通知（2 条件）"]
        LOG --> NTF
    end
    GRP["ジョブ管理グループ<br>ポータル・メール"]

    AI -->|"PR → merge"| REPO
    REPO -->|"git clone / pull"| vps
    RUN --> APPS
    RUN -->|"実行記録・status"| LOG
    NTF -->|"失敗時"| GRP
```

### 既存の VPS に相乗りさせるか

すでに VPS を持っているなら、そこに同居させたくなります。**判断はメモリの空きだけ見れば十分**です。

実際、私は別の VPS（2GB/3Core）で公開中の Web サービスを動かしており、最初はそこに載せようとしました。しかし状態を見ると:

```bash
free -h
#   total 1.9Gi / used 1.8Gi / free 74Mi     ← 空き 74MB
ps aux --sort=-%mem | head -5
#   アプリケーションサーバーのワーカー × 4（各 260〜390MB）+ 非同期ジョブ処理（326MB）
```

**空きが 74MB** では、kSQL Flow の実行（本連載の実測で RSS 200MB 超）が入りません。無理に載せれば、`npm install` やジョブ実行のたびに**公開中のサイトが OOM で落ちる**リスクがあります。結局、検証用に別の VPS（1GB）を立てました。

これはあくまで**1 例**です（メモリを多く使うアプリケーションだったという事情があり、同居先が軽いサービスなら話は変わります）。判断基準としては:

- **空きメモリが 500MB 以上**あれば同居を検討してよい（kSQL Flow のピーク + 余裕）
- **本番サービスが動いている**なら、影響の可能性がゼロでない以上は分けたほうが安い（VPS 1 台は月 1,000 円です）
- 同居させる場合も、**バッチの実行時刻を本番サービスの閑散時間に寄せる**

## セットアップ — 素の Ubuntu から 30 分

### 1. VPS を作る（ここで最重要の設定が 1 つ）

ConoHa なら Ubuntu 24.04 / 1GB プラン / 時間課金を選びます。**そして作成画面で必ず「SSH Key」を選択してください。**

これが**今回いちばん高くついた教訓**です。ConoHa の SSH Key は**サーバー作成時にしか `authorized_keys` へ注入されません**。後から鍵を作っても既存サーバーには反映されず、コンソール（VNC）から手動で登録する羽目になります。しかも**コンソールには長い公開鍵が貼り付けられません**（RSA 4096 なら 700 文字超）。

回避策として使えたのが、公開鍵を Gist（公開）に置いて **コンソールでは短い 1 行だけ打つ**方法です:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
curl -fsSL <GistのRAW URL> >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

（公開鍵は秘密情報ではないので Gist 公開で問題ありません。使い終わったら削除します）

**もう 1 つの教訓**: ユーザー名が分からず `root` / `ubuntu` / `admin`… と総当たりで試したところ、**BAN されて自分が締め出されました**。

調べると、**今回使った ConoHa の Ubuntu 24.04 イメージには fail2ban が最初から入っていて、sshd の jail が有効**でした（私はインストールしていません — パッケージの導入日がイメージのビルド時期になっており、稼働も確認済みです。ufw も有効でした）。イメージやプロバイダによって異なる可能性があるので、**自分の環境で `systemctl is-active fail2ban` を確認しておく**と安心です。

SSH の認証失敗は BAN 対象になり得ます。**コンソールという逃げ道が常にある**ことだけは覚えておいてください（BAN の解除も `fail2ban-client set sshd unbanip <IP>` でコンソールから可能です）。

### 2. Windows から SSH するなら鍵の ACL を絞る

Windows から接続する場合、`Load key ... bad permissions` で拒否されることがあります。**Windows の OpenSSH は Unix パーミッションではなく ACL を見る**ため、Git Bash の `chmod 600` では効きません。PowerShell で:

```powershell
icacls C:\path\to\key.pem /inheritance:r
icacls C:\path\to\key.pem /grant:r "$($env:USERNAME):(R)"
```

### 3. Node.js を入れる — ただし作成直後は apt が使えない

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v   # v22.23.2
```

（kSQL Flow の要件は **Node.js 20.6 以上**です。ここでは検証済みの LTS として 22 系を選んでいます）

これが**作成直後には失敗します**:

```
Waiting for cache lock: Could not get lock /var/lib/dpkg/lock-frontend.
  It is held by process 1381 (unattended-upgr)
E: Unable to acquire the dpkg frontend lock
```

Ubuntu の `unattended-upgrades`（自動セキュリティ更新）が起動直後に走っており、dpkg のロックを握っています。**10 分ほど待つ**か、ロック解放を待つループを挟んでください:

```bash
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 10; done
```

### 4. ジョブリポジトリを clone する

[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) でテンプレートから作った private リポジトリを持ってきます。GitHub CLI のデバイス認証が手軽です:

```bash
gh auth login --hostname github.com --git-protocol https --web
#   → 表示された 8 桁のコードをブラウザで入力して承認

gh auth setup-git          # ★ これを忘れないこと（後述）
gh repo clone rex0220/my-ksql-jobs /opt/ksql/my-ksql-jobs
cd /opt/ksql/my-ksql-jobs && npm ci
```

**`gh auth setup-git` が今回の 4 つ目の罠**です。`gh auth login` だけでは gh コマンド自身は認証されますが、**素の `git pull` は認証情報を見つけられません**:

```
fatal: could not read Username for 'https://github.com': No such device or address
```

clone は `gh repo clone` で通るので気づきにくく、**運用に入って最初の `git pull` で初めて発覚**します。無人サーバーでは致命的なので、セットアップ時に必ず実行してください。

### 5. トークンを置く

`.env` に**このサーバー用の書込可トークン**を置きます（無人サーバーには AI が同居しないので、[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) の開発機とは方針が変わります — [#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) と同じ考え方です）:

```bash
chmod 600 .env
node --env-file=.env node_modules/@rex0220/ksql-flow/dist/cli.js validate --check-logapp --profile prod
#   → OK: ログアプリ (ID ...) は 8.2 のフィールド定義を満たしています
```

> **root 運用について**: 本記事は検証を単純化するため root で構築しています（ConoHa の公式手順も root 接続を案内しています）。長期運用では**バッチ専用ユーザーを作り、リポジトリ・`.env`・cron の所有権をそのユーザーに分離する**構成も検討してください — [#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) で Windows 側について書いた「専用アカウントで動かす」と同じ考え方です。

## この VPS に載っているもの

セットアップ後の状態を整理します。**自分で入れたのは 2 つだけ**です。

| | パッケージ | バージョン | 用途 |
| --- | --- | --- | --- |
| **今回導入** | nodejs（NodeSource） | 22.23.2 | kSQL Flow の実行環境（要件は 20.6 以上） |
| **今回導入** | gh（GitHub CLI） | 2.98.0 | private リポジトリの clone と git 認証 |
| イメージ同梱 | git | 2.43.0 | ジョブの更新（`git pull`） |
| イメージ同梱 | cron | 3.0pl1 | 定期実行 |
| イメージ同梱 | **fail2ban** | 1.0.2 | SSH 総当たりの遮断（**有効**・前述の BAN の犯人） |
| イメージ同梱 | **ufw** | 0.36.2 | ファイアウォール（**有効**） |
| イメージ同梱 | unattended-upgrades | 2.9.1 | 自動セキュリティ更新（**作成直後の apt ロックの原因**） |
| イメージ同梱 | curl / wget / openssh-server | — | 取得・接続の基本ツール |

npm 側の依存はリポジトリ内（`node_modules`）に閉じており、グローバルインストールはありません:

```
@rex0220/ksql-flow          ^0.4.0   ← ランナー本体
@rex0220/kintone-sql-tools  ^3.72.0  ← SQL エンジン
```

**ディスクは 13MB**（リポジトリ + node_modules）、OS 全体でも 5.6GB/99GB。**メモリは OS 全体で 357〜379MB**（`free -m` の used）で、1GB プランに十分収まります。Docker も Web サーバーも要りません — **cron から node を叩くだけの構成**です。

## 起動スクリプトは Windows 版と同じ思想

`run_batch.sh` を用意します。[#4 の run_batch.bat](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) と設計が一対一で対応しています:

```sh
#!/bin/sh
# 配置先に依存しないよう、スクリプト自身のディレクトリへ移動する（.bat の %~dp0 と同じ思想）
cd "$(dirname "$0")" || exit 1
exec node --env-file=.env node_modules/@rex0220/ksql-flow/dist/cli.js run-all ./jobs --profile prod
```

- **`cd "$(dirname "$0")"`** = `.bat` の `cd /d %~dp0`。**cron はカレントディレクトリがホーム**になるので、これが無いと `.env` も `jobs/` も見つかりません
- **`exec node ...`** で node を直接起動 = Exit Code をそのまま cron へ返す（`npm run` を挟まない理由も #4 と同じ）
- **自動再起動は設定しない**。復旧は [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) の `--resume` に一本化

別ディレクトリから実行して、正しく動くことを確認します:

```bash
cd /tmp && /opt/ksql/my-ksql-jobs/run_batch.sh; echo "exit=$?"
#   => NO_DATA (exit 0) 読取 0 件 / 書込 0 件 / API 5 回
#   exit=0
```

## cron 登録 — そして遅延 1 秒の実測

```bash
mkdir -p /var/log/ksql
crontab -e
```

```cron
7 6 * * * /opt/ksql/my-ksql-jobs/run_batch.sh >> /var/log/ksql/batch.log 2>&1
```

**タイムゾーンの確認だけしてください** — ConoHa の Ubuntu イメージは最初から `Asia/Tokyo` でした:

```bash
timedatectl | grep 'Time zone'
#   Time zone: Asia/Tokyo (JST, +0900)
```

[#6 の GitHub Actions では UTC 換算が必要](https://qiita.com/rex0220/items/a522f7880a5960f033b3)（6:07 JST = 21:07 UTC）でしたが、**cron はローカルタイムでそのまま書けます**。UTC のイメージを使う場合は `timedatectl set-timezone Asia/Tokyo` で合わせるか、UTC で書いてください。

そして本題の実測です。16:25 に発火する cron を登録して待ちました:

| | 予定 | 実際 | 遅延 |
| --- | --- | --- | --- |
| **VPS + cron** | 16:25:00 | **16:25:01** | **+1 秒** |
| [#6 GitHub Actions](https://qiita.com/rex0220/items/a522f7880a5960f033b3)（参考） | 6:07 / 22:37 | 6:37 / 6:38 / 23:22 | **+30 / +31 / +45 分** |

※ これは**今回の VPS における 1 回の実測値**で、cron が常に 1 秒以内に起動することを保証するものではありません（負荷の高いサーバーでは当然遅れます）。それでも、分単位の遅延が常態化する [#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) の実測とは明らかに別の水準です。

これが VPS を選ぶ最大の理由です。**「9 時の始業までに終わっていればよい」なら Actions で十分ですが、「6 時台に確実に終わっていてほしい」なら VPS か社内サーバー**、という判断基準になります。

## コストの正直な話 — 月 1,064 円は総コストではない

ここまで「月 1,000 円」を前面に出してきましたが、**それは金銭コストだけ**です。実際の総コストには人の工数が乗ります。しかもそちらのほうが大きい。

| コスト | VPS + cron | [#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) GitHub Actions | [#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) 既存 Windows サーバー |
| --- | --- | --- | --- |
| 金銭 | 月 1,064 円 | 実質ゼロ（無料枠内） | ゼロ（既存資産） |
| 導入工数 | **約 30 分**（本記事の実測） | 約 10 分（Secrets 設定のみ） | 約 15 分 |
| **OS の保守** | **自分（更新・再起動・障害対応）** | **不要**（GitHub 任せ） | 既存の情シス運用に相乗り |
| **鍵・認証の管理** | SSH 鍵・root パスワード・gh トークン | GitHub の Secrets 管理のみ | 既存のアカウント運用 |
| **手順書の保守** | 必要（構築・復旧手順） | 少ない（YAML がそのまま手順） | 必要 |

VPS は金銭コストが最安の部類ですが、**保守工数だけは自分に来ます**。逆に GitHub Actions は時刻がずれる代わりに、OS 更新も鍵管理も存在しません。「月 1,000 円 vs 無料」ではなく、**「時刻の正確さを、保守工数で買う」**という取引だと考えるのが正確です。

そして**表に現れにくいのに、実務でいちばん時間を食うのが「決めごと」の工数**です。手を動かす前の環境設計と、動かした後の運用ルール作成 — これが環境ごとにかなり違います。

| 決めること | [#4](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) Windows | [#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) Actions | **#9 VPS** |
| --- | --- | --- | --- |
| 実行アカウント設計 | 専用アカウント / gMSA / パスワード保存の可否 | 不要（GitHub 任せ） | root か専用ユーザーか・sudo の範囲 |
| 秘密情報の置き場と更新手順 | `.env` + NTFS 権限・**誰が更新するか** | Secrets（GitHub の権限管理に相乗り） | `.env` + パーミッション・**SSH 鍵と gh トークンの管理も追加** |
| アクセス経路と権限 | 既存の AD / 情シス運用に相乗り | GitHub の Collaborator 権限 | **SSH 鍵の配布・回収ルールを自分で作る** |
| パッチ・再起動ルール | 既存のサーバー運用に相乗り | 不要 | **自分で決める**（前述の方針 A/B/C） |
| 障害時の連絡・対応ルール | 既存の情シス窓口 | 同左 or 開発チーム | **誰が SSH で入るのか**まで決めておく |
| 監視・死活確認 | 既存の監視に相乗りできることが多い | Actions の失敗通知 | **自分で用意**（heartbeat・[#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) の「起動しなかった事故」） |
| ドキュメント | 手順書 + 引き継ぎ | **YAML がほぼ手順書** | 構築手順・復旧手順・鍵の在り処 |

見てのとおり、**#4 は「既存の運用ルールに相乗りできる」ぶん決めごとが少なく、#6 は「決めるべきことが構造的に存在しない」**という強さがあります。**VPS は自由度が高い代わりに、全部自分で決める**必要があります。

この工数は導入時に 1 回で終わりません — 担当者が替われば見直しになり、ルールが文書化されていなければ「前任者しか知らない」状態になります。**金銭の差（月 1,000 円）より、この差のほうが大きい**というのが正直なところです。

### 忘れてはいけない — kSQL Flow 自体の学習コスト

ここまで環境側のコストだけを比べてきましたが、**環境を選ぶ前に、ツールを使えるようになるコスト**があります。これは #4 / #6 / #9 のどれを選んでも同じだけかかります。正直に見積もります。

| 学ぶこと | 目安 | 補足 |
| --- | --- | --- |
| SQL でジョブを書く | **既に SQL が書けるなら短い** | ほぼ標準 SQL。差分は `ASSERT` / `EXIT SUCCESS IF` / `UPSERT KEY` / `@` 付き時刻関数くらい |
| 冪等・as-of の考え方 | **ここが本体** | [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2)・[#8](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a) の内容。「再実行しても壊れない設計」に頭を切り替える必要がある |
| 運用装備の理解 | 半日程度 | Exit Code・ログアプリ・分散ロック・`--resume`。[#7 の対応表](https://qiita.com/rex0220/items/39821af2a79b88de0ed2)を 1 枚持っておけば足りる |
| 実行環境の構築 | **本記事の 30 分**（VPS の場合） | ここだけが環境ごとに違う部分 |

**割合で言えば、環境構築は学習コスト全体の小さい部分**です。この連載が #7・#8 で設計の話に紙幅を割いたのは、そこが本体だからです。

学習コストを下げる手段も 2 つあります:

- **[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) の AI 生成** — ジョブ SQL を AI に書かせ、人間は dry-run の差分をレビューする。**SQL の書き方より「差分を読む力」のほうが要る**構成になり、学習の入口が下がります
- **テンプレート** — 検証済みのサンプルジョブ・設定・起動スクリプト・ワークフローが揃っているので、白紙から始める必要がありません

一方で、**下がらないコストもあります**。冪等性・as-of・部分適用の理解は、AI にもテンプレートにも肩代わりできません。ジョブを設計するのは人間で、[#8 のクラス C・D](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a)（正常終了するのに結果がずれる失敗）を避けられるかどうかは、ここの理解にかかっています。

**そして忘れやすいのが、この学習コストにも「安定するほど忘れる」が効く**ことです。半年間何事もなく動いた後、初めての障害に対応するとき、Exit Code の意味も `--resume` の挙動も覚えていません。[#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) を保存版として置いておく価値は、そこにあります。

### 安定するほど、いざという時が高くつく

見落とされがちな逆説がこれです。**1 年間何事もなく動いた構成ほど、トラブル時の対応工数は大きくなります。**

- 構築した本人が**手順を忘れている**（今回の罠 5 つも、1 年後の自分は覚えていません）
- **担当者が替わっている**（引き継ぎ資料に SSH 鍵の在り処が書かれていない、という事故は定番です）
- **手順書が腐っている** — Ubuntu も Node も NodeSource も 1 年で変わります。書いた通りに動かない
- **そもそも障害対応に慣れていない**（毎日成功していれば、Exit Code を見るのも 1 年ぶりです）

対策は、運用の話に踏み込むと長くなるので要点だけ:

1. **手順を人ではなくリポジトリに置く** — 本記事の `run_batch.sh` も cron 行も、[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) のジョブリポジトリに入れておけば、手順書と実物が同時に更新されます（As Code の効用は、まさにここです）
2. **復旧手順を 1 枚に畳んでおく** — [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) の「症状 → 見る場所 → 対応」の表は、そのまま 1 年後の自分への引き継ぎ資料になります
3. **鍵とパスワードの在り処を決めておく** — SSH 秘密鍵・root パスワード・gh のトークンが**どこにあり、誰が再発行できるか**。今回、私は「ConoHa のコンソールから入れる」という逃げ道に何度も救われました
4. **年 1 回でいいので壊してみる** — [#7 でやった障害ドリル](https://qiita.com/rex0220/items/39821af2a79b88de0ed2)（意図的に ASSERT を失敗させて `--resume` で戻す）を定期的に回すと、手順の腐りに気づけます

そして**この観点で見ると、[#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) の GitHub Actions がかなり有利**です。OS 保守が無く、手順が YAML としてリポジトリに残り、実行履歴も GitHub に残る。**「時刻が多少ずれてもよい」なら、長期の総コストでは Actions が勝ちます。**

## セキュリティパッチはどう当てるか — 自動更新の落とし穴

「OS 保守は自分に来る」の中身で、いちばん実害が出やすいのがここです。実機で確認したところ、**Ubuntu の既定は「更新は自動・再起動は手動」**でした。

```bash
cat /etc/apt/apt.conf.d/20auto-upgrades
#   APT::Periodic::Update-Package-Lists "1";   ← 毎日パッケージ一覧を更新
#   APT::Periodic::Unattended-Upgrade "1";     ← 毎日セキュリティ更新を適用
```

つまり `-security` リポジトリの更新は**放っておいても毎日入ります**（今回、セットアップ中に走っていた `unattended-upgrades` がこれです）。ここまでは良い知らせです。

問題は次です。セットアップから 42 分後のサーバーを見ると:

```bash
cat /var/run/reboot-required
#   *** System restart required ***
cat /var/run/reboot-required.pkgs
#   libc6
#   linux-image-6.8.0-138-generic
#   linux-base

uname -r                      # 稼働中のカーネル
#   6.8.0-90-generic
dpkg -l 'linux-image-*'       # ディスク上のカーネル
#   linux-image-6.8.0-138-generic  ← 新しいものが入っている
```

**新しいカーネルと libc6 は適用済みなのに、動いているのは古いカーネル**です。`Unattended-Upgrade::Automatic-Reboot` は既定で `false` なので、**誰かが再起動するまで、パッチは効いていません**。「自動更新を有効にしたから安心」がいちばん危ない誤解で、`reboot-required` が何ヶ月も放置された VPS は珍しくありません。

### 運用ルールの決め方

バッチサーバーは Web サーバーと違って**停止できる時間帯が明確**なので、ルールは単純にできます。

**方針 A: 自動再起動（バッチの実行時刻を避けて）**

```bash
# /etc/apt/apt.conf.d/50unattended-upgrades
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";   # バッチ 6:07 の 2 時間前
```

バッチの時刻から十分離せば、実行中に落とされる心配はありません。**再起動が数分遅れても [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) の as-of 固定と冪等リランがあるので、最悪 1 回スキップされても翌朝収束します**（[#8](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a) のクラス D と同じ構造です）。手離れを優先するならこれが最適解です。

**方針 B: 手動再起動（月次などの点検日に）**

```bash
# 月次点検で確認する 3 行
ls /var/run/reboot-required 2>/dev/null && echo "再起動が必要です"
cat /var/run/reboot-required.pkgs 2>/dev/null    # 何が待っているか
uname -r; dpkg -l 'linux-image-*' | grep ^ii     # 稼働 vs 導入済みカーネル
```

止めるタイミングを自分で握りたい場合はこちら。ただし**「点検日を守る」という人間の工数が毎月かかります** — 前節で書いた「安定するほど忘れる」がそのまま効いてきます。

**方針 C: Livepatch（再起動なしでカーネルパッチ）**

Ubuntu Pro（個人・小規模なら無料枠あり）を有効にすると、`livepatch` でカーネルの再起動を先送りできます。今回の VPS でも `pro status` に `esm-infra` / `esm-apps` が利用可能と出ていました。ただし**再起動が完全に不要になるわけではなく**（libc6 の更新などは結局再起動が要ります）、管理対象が 1 台増えるとも言えます。

### 再起動を自動化してよいか — リスクの見積もり

「自動で再起動させる」と聞くと不安になりますが、**バッチサーバーでは自動化のほうが安全**だと考えています。リスクを 4 つに分けて見積もります。

**① バッチ実行中に再起動が重なる**

実行時刻から十分離せば起きません（6:07 のバッチに対して再起動 4:00 なら 2 時間の間隔）。それでも重なった場合は、[#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) の設計が保険になります — **部分適用で止まり、翌朝の実行が冪等上書きで収束**します（[#8](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a) のクラス D と同じ構造）。ロックが `RUNNING` のまま残っても、次回実行が `batchTimeoutSec` 超過を検知して自動回収します。

**② 再起動でその日の実行が飛ぶ**

**cron には「停止中に来た予定を後から実行する」機能がありません**。再起動が長引いて実行時刻をまたぐと、その日は動きません。対策は 2 つ:

- **systemd timer の `Persistent=true`** を使う（前述）— 起動後に追いかけて実行します
- ジョブを**累積・全量型**にしておく（[#8](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a) の議論）— 1 回飛んでも翌日の実行が吸収します

**③ 再起動後にサービスが上がってこない**

`systemctl is-enabled` で確認しておけば防げます。**ただし Ubuntu 24.04 で 1 つ紛らわしい点**があります:

```bash
systemctl is-enabled cron ssh fail2ban ufw
#   cron      enabled
#   ssh       disabled   ← ぎょっとしますが……
#   fail2ban  enabled
#   ufw       enabled

systemctl is-enabled ssh.socket
#   enabled              ← こちらが有効なので問題ありません
```

Ubuntu 24.04 の SSH は **socket activation**（接続が来たときに起動する方式）に変わっており、`ssh.service` は disabled が正常です。`ssh.socket` が enabled なら再起動後も接続できます。**「SSH が disabled だ」と早合点して設定をいじると、かえって壊します**。

**④ 再起動そのものが失敗する（起動しない）**

まれですが、カーネル更新後に起動しない可能性はゼロではありません。だからこそ **VPS のコンソール（VNC）から入れることを確認しておく**のが重要です（本記事の最初の罠で、私はこれに救われました）。クラウド側のスナップショット機能があれば、パッチ適用前に取っておくとさらに安全です。

**逆に「自動化しない」リスク**も直視してください — 前節で見たとおり、`reboot-required` は**放置すると溜まり続け、脆弱性が当たっていない状態が何ヶ月も続きます**。「安定するほど忘れる」という前節の逆説がここでも効きます。①〜④ は設計で潰せますが、**人間が忘れることは設計では潰せません**。

### バッチサーバーとしての推奨

私は **方針 A（時刻をずらした自動再起動）+ 月次の目視確認**を勧めます。理由は 3 つ:

1. バッチは**停止可能な時間帯がはっきりしている** — Web サービスと違い、深夜の数分停止のコストがほぼゼロ
2. **冪等リランがあるので、再起動と実行がぶつかっても壊れない** — [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2) の設計がここで効きます
3. **人の記憶に依存しない** — 前節の「安定するほど手順を忘れる」問題に対して、いちばん強い対策が自動化です

そのうえで、月に 1 度でいいので `ls /var/run/reboot-required` を見る習慣をつけてください（[#4 の heartbeat](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) と同じで、**自動化しても「効いているか」の確認だけは人間に残ります**）。

なお [#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) の GitHub Actions では、**この節の話が丸ごと存在しません** — 実行環境は毎回新品の使い捨てで、パッチも再起動も GitHub 側の仕事です。前節のコスト比較で「長期の総コストでは Actions が勝つ」と書いた最大の理由がこれです。

## 失敗と復旧も同じように動く

環境が変わっても運用装備は変わらない、というのが連載の主張です。VPS 上でも [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2)・[#8](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a) の仕組みがそのまま動くことを確認しました。

マイナス売上のデータを混ぜて、業務異常を起こします:

```
[JOB] 01_negative_check.sql
  => ABORTED (exit 2) 読取 1 件 / 書込 0 件 / API 4 回
  エラー内容: AssertError: ... 【異常中断】KSQL-FLOW-TEST 案件にマイナス売上があります
[SKIP] 02_summary.sql (dependency: drill_negative_check)
[RESULT] ABORTED (exit 2) — ABORTED 1 / SKIPPED 1
```

kintone のログアプリに記録され、条件通知も飛びます（[#4 で組んだ 2 条件](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4)がそのまま効きます — 通知の仕組みは実行環境に依存しません）。データを修正して `--resume`:

```
--resume: 元セッションの as-of を引き継ぎます (2026-08-27T07:25:00.000Z)
  => SUCCESS (exit 0) 読取 0 件 / 書込 0 件 / API 4 回
  => SUCCESS (exit 0) 読取 11 件 / 書込 1 件 / API 8 回
[RESULT] SUCCESS (exit 0) — SUCCESS 2
```

**失敗時の as-of を引き継いで、失敗したジョブと巻き添えでスキップされたジョブの両方が再実行**されました。#7 で Windows 上・開発機上で確認したのと同じ挙動です。

## systemd timer という選択肢

cron の代わりに systemd timer も使えます。1 日 1 回のバッチなら cron で十分ですが、次の 2 点が欲しいなら検討の価値があります:

- **`Persistent=true`** — サーバー停止中に実行時刻を過ぎた場合、**起動後に追いかけて実行**します（[#4 の `-StartWhenAvailable`](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) と同じ機能。cron にはありません）
- **journald に実行記録が残る** — `systemctl status` / `journalctl -u` で追える

```ini
# /etc/systemd/system/ksql-batch.service
[Service]
Type=oneshot
ExecStart=/opt/ksql/my-ksql-jobs/run_batch.sh

# /etc/systemd/system/ksql-batch.timer
[Timer]
OnCalendar=*-*-* 06:07:00
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now ksql-batch.timer
systemctl list-timers ksql-batch.timer   # 次回実行時刻の確認
```

ただし**「起動しなかった事故」は依然として検知できません**（#4 の heartbeat の議論と同じ）。`Persistent=true` は「サーバーが起動した後に追いかける」だけで、サーバーが落ちたままなら何も起きません。

## PR 検証は GitHub Actions に残せる

もう 1 つ、[#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) の読者向けの補足です。**pr-check（PR ごとの validate + dry-run 差分コメント）は `pull_request` イベントで動くので、定期実行を VPS に移しても使えます。**

つまり組み合わせが可能です:

| 役割 | 担当 |
| --- | --- |
| 定期実行（正確な時刻） | **VPS + cron** |
| PR 検証（差分の自動コメント） | **GitHub Actions（pr-check のみ）** |

この構成の利点は時刻の正確さだけではありません — **GitHub に置くのは閲覧のみトークンだけで済み、書込可トークンは VPS の `.env` にしか存在しない**ことになります。秘密の露出面がむしろ減ります。

逆に「cron から GitHub Actions を叩く」構成（`gh workflow run` を cron で実行）は勧めません。cron を動かすマシンがあるなら直接実行したほうが単純で、GitHub PAT の管理も、Actions のキュー待ちも増えるだけです。

## セットアップで踏んだ罠まとめ

| 罠 | 対処 |
| --- | --- |
| SSH 鍵が入っていない | **VPS 作成時に SSH Key を選択**する。後付けはコンソールから（長い鍵は Gist 経由 curl で） |
| 認証の総当たりで自分が BAN | コンソールから `fail2ban-client set sshd unbanip <IP>` |
| Windows から `bad permissions` | `icacls` で鍵の ACL を絞る（`chmod` は効かない） |
| 作成直後に apt が使えない | `unattended-upgrades` の dpkg ロック解放を待つ |
| **`git pull` が認証エラー** | **`gh auth setup-git` を実行**（`gh auth login` だけでは足りない） |

## まとめ

- **cron の遅延は今回の実測で 1 秒**（n = 1）。[#6 の GitHub Actions（+30〜99 分）](https://qiita.com/rex0220/items/a522f7880a5960f033b3)との差は、時刻に締切があるジョブでは決定的
- セットアップは素の Ubuntu から **約 30 分**（Node 導入 → clone → `.env` → cron）。検証時の **OS 全体の使用メモリは 357〜379MB**（`free -m` の used）で、1GB プランに余裕をもって収まる
- 起動スクリプトは [#4 の `.bat`](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4) と一対一対応 — **`cd "$(dirname "$0")"` が `%~dp0` の代役**。cron は cwd がホームなので必須
- 失敗・通知・復旧（`--resume`）は [#7](https://qiita.com/rex0220/items/39821af2a79b88de0ed2)・[#8](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a) のまま動く — **スケジューラを変えても運用設計は変わらない**
- **定期実行は VPS・PR 検証は Actions** の組み合わせが可能。書込トークンを GitHub に置かずに済む
- **セキュリティパッチは自動で入るが、再起動は手動が既定** — 実機でも 42 分で「要再起動」（新カーネル + libc6）が溜まった。バッチサーバーは停止可能な時間帯が明確なので、**実行時刻を避けた自動再起動**が現実的
- ただし**月 1,064 円は総コストではない** — OS 保守・鍵管理・手順書の維持という工数が乗る。しかも**安定して動くほど、いざという時の対応工数は増える**（手順を忘れ、担当が替わり、手順書が腐るため）。時刻が多少ずれてよいなら、長期の総コストでは [#6](https://qiita.com/rex0220/items/a522f7880a5960f033b3) が勝ちます
- 罠は 5 つ。特に **`gh auth setup-git` 忘れ**は、運用開始後の最初の `git pull` で初めて牙をむく

## 連載

1. **#1**: [kintone のバッチ処理を SQL 1 本で書けるランナーの紹介](https://qiita.com/rex0220/items/893ab4016a5aaf595642)
2. **#2**: [AI エージェントに kintone のバッチジョブを書かせる — MCP + Claude Code](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa)
3. **#3**: [毎朝の無人実行の前に — kintone バッチを 200 → 20,000 → 100,000 件で鍛える](https://qiita.com/rex0220/items/62e950ab1ccc5b54ff69)
4. **#4**: [タスクスケジューラで毎朝動かす — PowerShell が 0.1 秒で無言死する罠つき](https://qiita.com/rex0220/items/d0a66c133edd42ff91c4)
5. **#5**: [kintone バッチの API 消費を 4 割減らすまで — 「束ねれば速い」が実測で覆った話](https://qiita.com/rex0220/items/9cbc1e0e9b5ab292e6a1)
6. **#6**: [GitHub Actions で kintone バッチをサーバーレス運用 — PR を開くと「書込差分」が自動で貼られる](https://qiita.com/rex0220/items/a522f7880a5960f033b3)
7. **#7**: [kintone バッチが失敗した朝にやること — Exit Code・部分適用・再実行しても壊れない設計](https://qiita.com/rex0220/items/39821af2a79b88de0ed2)
8. **#8**: [バッチの失敗は 4 種類ある — 自動リラン・AI 診断・人間の判断の切り分け](https://qiita.com/rex0220/items/30cac8d8b52ec8ac782a)
9. **#9（本記事）**: 月 1,000 円の VPS で kintone バッチを毎朝動かす
10. 以降、Google Cloud（Cloud Run Jobs）と、設計深掘りの続き（分散ロックの内部・全文検索索引の書込ラグ実測）を予定
