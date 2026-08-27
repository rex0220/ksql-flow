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
