# Linux cron / Docker 実機検証 企画 R1（連載 #7 素材採取）

- 起案日: 2026-08-26（起案: Claude Code、裁定: Takashi）
- 状態: **企画 R1・未着手**。Ubuntu ゲストの準備から着手可
- 裁定履歴: 2026-08-26 — 台 A の OS を **Ubuntu Server 24.04 LTS で確定**（Takashi）。§9-3 解消。実機は **24.04.3 LTS (arm64)** を導入済み（ポイントリリースは同一 LTS 系列。記事にはパッチレベルまで明記する）
- 対象: kSQL Flow **v0.4.0**（実施時の最新に読み替え） + kintone-sql-tools v3.73.0
- 実施場所: dev 環境（実ドメイン・トークンは記載しない）
- 記事: 連載 **#7**（②GitHub Actions = #6 の次）。検証手順がそのまま記事の章になる設計（§10）

## 1. 背景と目的

- `examples/cron/ksql.cron` と `examples/docker/Dockerfile` は**設計書 付録 A-3 / A-4 のスケルトンのまま**で、実機検証を経ていない。cron は 1 行、Dockerfile は 7 行しかなく、環境変数の注入・`.ksql` の書込先・ログローテ・タイムゾーンといった実運用の要素が未定義
- 「記事 = examples 一致」の規約がある以上、**検証を通して examples を実運用可能な形に育てることが本検証の主目的**。記事はその副産物
- 連載の主張（スケジューラが変わっても運用設計は変わらない = 排他・記録・リランはランナーとログアプリが持つ）を、**実行環境が使い捨てになる Docker で成立させられるか**が最大の検証点
- **`.ksql` の位置は `process.cwd()` 固定**（[lock.ts:24](../../src/lock.ts#L24) / [state.ts:39](../../src/state.ts#L39)）。`logging.localDir` だけが config で可変。読み取り専用 FS・使い捨てコンテナでこれがどう効くかを実機で確定し、必要なら製品改善として起票する（記事プラン ④'-b の「ローカルロックディレクトリの設定可能化」候補の判断材料）

## 2. 検証環境

| 台 | 実体 | アーキ | 役割 |
| --- | --- | --- | --- |
| **A** | M1 MacBook Pro + Parallels Desktop / Ubuntu Server 24.04 LTS | arm64 | 本命。cron・systemd・logrotate・Docker の全検証。#4 と同じ「素の OS を VM に立てて通す」手口 |
| **B** | GitHub Actions `ubuntu-latest` runner | **x86_64** | クロスアーキ実行確認専用。#6 で整備済みの Secrets（**閲覧のみトークン**）を流用し `--dry-run` まで |
| C（任意・未決） | 月 1,000 円前後の x86 VPS を 1 か月 | x86_64 | 台 B で足りない場合のみ。cron + Docker の通し運用を実サーバーで再現（§9-1） |

- **Apple Silicon の Parallels は arm64 ゲストのみ**動く。台 A だけで完結させると Docker 章が arm64 未満の検証になるため、台 B を必須とする
- 台 A のホストがスリープすると cron は発火しない。長時間の無人試験はせず、**cron は数分後に発火させて確認する**方式（「毎朝動く」の実証範囲は #4 と同じく「指定時刻に起動して結果がログアプリに残る」まで）

### 規約（既存踏襲）

- 書込を伴う実行は**人間が書込可トークンで**実施（セッション限定の環境変数）。台 B（Actions）には**閲覧のみトークンしか置かない** — dry-run 専用
- 記事・examples に載せるのは `example.cybozu.com` と `env:` 参照のみ
- 検証専用 profile を用意（`unlock` は同一 profile の全 RUNNING を解除するため通常利用と分離）
- 使うジョブはテンプレート同梱のサンプル + `--dry-run`。実データ更新を伴う試験は #3 の `KSQL-FLOW-TEST-` 名前空間の作法に従う

## 3. 事前準備

0. 台 A: **Ubuntu Server 24.04 LTS (arm64)** を Parallels に導入 → `batch` ユーザー作成 → Node.js 20.6+ 導入（**導入方式は §9-2 で確定**。apt の `nodejs` は 18 系で不足）→ `npm i -g @rex0220/ksql-flow@<version>` → `ksql-flow --version` 記録
0'. Docker は **Docker 公式 apt リポジトリ版**を入れる（`docker-buildx-plugin` が同梱されるため）。ディストリ同梱の `docker.io` では X-2 の `docker buildx` が使えない可能性があるため、`docker buildx version` の成功を準備の完了条件にする
1. `/opt/ksql-project/` にテンプレート相当（jobs/ + ksql.config.json + .env）を配置。`.env` は 600・所有者 `batch`
2. 記録スキーマを先に作る — `verification/linux-docker-notes.md`（版数・commit・コマンド全文・batch_id とスクショの対応表）
3. 手動実行が通ることを先に確認（C-1）。**cron 化はその後**（手動で通らないものを cron でデバッグしない）

### 3.1 具体手順（台 A・Ubuntu Server 24.04.3 LTS arm64）

**実行方法**: `script -q ~/setup-<日時>.log` で記録を開始し、**`# --- n)` のコメント単位で 1 ブロックずつ貼り付ける**（一括投入しない）。理由は §10「記事の記法規約」と同じ — 出力を 1 つずつ確認して記録するのが目的であり、手順 2 は `NODE_VERSION` / `WORKDIR` が同一シェル内で解決される必要があるため。準備を `setup.sh` に一括化するのは**検証確定後**（未検証スクリプトを記事に載せない）。

**方針**: Node は**公式 tarball**（④'' レンタルサーバー編と同じ手口に揃える）。`node` / `npm` は `/usr/local/bin` に symlink するが、**`ksql-flow` は PATH に通さない** — グローバル install 先は tarball 側の `bin` になるため、C-2 の「cron から `command not found`」が素の状態で自然に再現される。**PATH を先回りして直さないこと**。

```bash
# --- 0) 記録（何も入れる前に採る。§9-2 の素材） --------------------------
{ lsb_release -a; uname -rm; timedatectl; apt-cache policy nodejs; \
  systemctl is-active cron; command -v logrotate; } 2>&1 | tee ~/env-before.txt

# --- 1) batch ユーザーとディレクトリ ------------------------------------
sudo adduser --system --group --home /opt/ksql-project --shell /bin/bash batch
sudo install -d -o batch -g batch -m 0750 /opt/ksql-project
sudo install -d -o batch -g batch -m 0750 /var/log/ksql

# --- 2) Node.js 22 LTS（公式 tarball・arm64） ---------------------------
# 最新パッチは https://nodejs.org/dist/latest-v22.x/ で確認して置換
NODE_VERSION=v22.20.0
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
sha256sum -c --ignore-missing SHASUMS256.txt          # 完全性確認（記事にも載せる）
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf "node-$NODE_VERSION-linux-arm64.tar.xz" -C /usr/local/lib/nodejs
sudo ln -sfn "/usr/local/lib/nodejs/node-$NODE_VERSION-linux-arm64" /usr/local/lib/nodejs/current
sudo ln -sfn /usr/local/lib/nodejs/current/bin/node /usr/local/bin/node
sudo ln -sfn /usr/local/lib/nodejs/current/bin/npm  /usr/local/bin/npm
node -v && npm -v

# --- 3) kSQL Flow（バージョン固定） -------------------------------------
sudo /usr/local/bin/npm i -g @rex0220/ksql-flow@0.4.0
/usr/local/lib/nodejs/current/bin/ksql-flow --version   # 絶対パスで叩く（PATH には通さない）

# --- 4) ジョブと config の配置 ------------------------------------------
# jobs/ と ksql.config.json はテンプレート相当を scp / git clone で配置
sudo chown -R batch:batch /opt/ksql-project
sudo -u batch install -m 0600 /dev/null /opt/ksql-project/.env
sudo -u batch tee /opt/ksql-project/.env >/dev/null <<'EOF'
KINTONE_BASE_URL=https://example.cybozu.com
KSQL_API_TOKEN_RO=...   # 検証中のみ。書込可トークンは人間の実行時のみ環境変数で渡す
EOF

# --- 5) C-1: 手動実行（batch ユーザーで） --------------------------------
sudo -u batch bash -lc 'cd /opt/ksql-project && set -a && . ./.env && set +a && \
  /usr/local/lib/nodejs/current/bin/ksql-flow run-all ./jobs --profile dev --dry-run'
```

**Docker（公式 apt リポジトリ版・buildx 同梱）**:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker buildx version        # ← 準備の完了条件
```

- **`batch` を `docker` グループに入れるのは D-7 の直前まで待つ**。docker グループ所属は実質 root 権限であり、記事でもその注意を書く必要がある（cron から `docker compose run` を叩く構成の代償）
- `.env` に置くのは**閲覧のみトークン**。書込を伴う C-1 本実行・D-5 中断試験は、人間がその場の環境変数で書込可トークンを渡して実行する

## 4. 検証観点

### 4.1 cron 編（台 A）

| # | 観点 | 合否基準 |
| --- | --- | --- |
| C-1 | 手動実行 | `run-all ./jobs --dry-run` → 本実行が成功し、ログアプリに BATCH/JOB が残る |
| C-2 | **cron の素の環境で 1 回落とす**（記事の罠①・撮り逃し厳禁） | `examples/cron/ksql.cron` を**そのまま**登録して失敗を実測。想定は `ksql-flow: command not found`（PATH が `/usr/bin:/bin` のみ）または `env:` 未解決（`.env` を読まない）。**失敗ログ全文と `/var/log/syslog` の cron 行を保存** |
| C-3 | 対策後の成功 | 絶対パス起動 sh（自分の場所へ cd → `set -a; . ./.env; set +a` → 絶対パスで CLI 起動）に差し替えて成功。#4 の `%~dp0` と同じ思想であることを記録 |
| C-4 | 環境変数の置き場所 | `.env` 方式（600）と `/etc/cron.d` 内 `KEY=value` 方式の両方を実測し、**トークンが `ps` や cron ログに出ないこと**を確認して推奨形を 1 つ決める |
| C-5 | タイムゾーン（3 ケース実測） | 台 A はインストーラ既定で **JST**（罠を演出せず事実として書く。クラウドの VPS は UTC 既定が多い、が記事の接続点）。①JST のまま `0 6 * * *` → 6 時発火 ②`timedatectl set-timezone UTC` → 同じ cron 行が 15 時発火になることを実測 ③**`CRON_TZ=Asia/Tokyo` を付けると OS 設定に関係なく 6 時発火**（Ubuntu の cron で CRON_TZ が効くかの確認そのものが合否。効かない場合は起動 sh 側 `TZ=` か UTC 換算にフォールバックし、その事実を記事に書く）。あわせて**config の `timezone` と OS/cron の TZ は別物**（as-of の基準はランナー側）を切り分けて記録 |
| C-6 | ログローテーション | logrotate で `/var/log/ksql/cron.log` が回る。追記リダイレクト（`>>`）と併用するため **`copytruncate` の要否**を実測（`create` だと旧 inode に書き続ける事象の有無） |
| C-7 | 二重起動 | 短周期 cron（毎分）で前回終了前に再発火させ、**Exit 5 で即終了**することを確認。ローカルロック（同一ホスト）で止まるのか分散ロックまで行くのかをログで区別 |
| C-8 | 失敗通知 | 失敗系ジョブで Webhook 通知 + ログアプリ条件通知が届く（各 1 回）。cron の MAILTO には**依存しない**ことを明記 |
| C-9 | 権限 | `batch` ユーザーで `/opt/ksql-project/.ksql` が作成・書込できる。root で 1 回実行した後に `batch` で実行すると詰まる（所有者の混在）事象の有無を確認 |

### 4.2 Docker 編（台 A・arm64）

| # | 観点 | 合否基準 |
| --- | --- | --- |
| D-1 | ビルド | `examples/docker/Dockerfile` がビルドできる。**`npm i -g @rex0220/ksql-flow` はバージョン非固定**で再現性がないため、`@<version>` 固定への改訂要否を判断（examples 改訂候補） |
| D-2 | イメージに秘密が入らない | `docker history` / `docker run --rm <img> env` で**トークンが焼き込まれていない**こと。`.dockerignore`（`.env` / `.ksql` / `node_modules`）の要否を判断 |
| D-3 | env 注入 | `--env-file` と compose の `env_file` の両方で config の `env:` 参照が解決される |
| D-4 | **`.ksql` の書込先**（設計上の要点） | `WORKDIR /app` が書込可能である前提を実証。**`--read-only` で起動すると `.ksql` 作成に失敗する**はずなので、①`-v` で永続化 ②`--tmpfs /app/.ksql` の 2 案を実測。cwd 固定（§1）ゆえの制約として結果を記録し、**必要なら「ロックディレクトリ設定可能化」を製品改善として起票** |
| D-5 | **使い捨てコンテナでの中断 → リラン**（記事の目玉①・撮り逃し厳禁） | 書込途中で `docker kill`（SIGKILL）→ ログアプリが RUNNING + `last_written_key` で残る → **コンテナを作り直して**（`.ksql` は失われた状態で）`unlock` → `run-all --resume` → 突合一致。**ログアプリが正だからローカル状態が消えても継続できる**ことの実証 |
| D-6 | D-5 の対照（正直に書く用） | `.ksql` を volume で永続化した場合との差分。**ローカル JSONL に退避された pending が失われるケースの影響**（ログアプリ書込不能時のフォールバックが消える）を明示。「消えても resume は成立するが、失う情報はある」まで書く |
| D-7 | compose + ホスト cron | 常駐ではなく `docker compose run --rm` を cron から叩く run-to-completion 型。C-3 の起動 sh と組み合わせて成功 |
| D-8 | コンテナのタイムゾーン | 既定 UTC。`TZ=Asia/Tokyo` 注入の要否と、ログ表示・as-of への影響を切り分けて記録 |

### 4.3 クロスアーキ（台 A → 台 B・記事の目玉②）

| # | 観点 | 合否基準 |
| --- | --- | --- |
| X-1 | **arm64 イメージを x86_64 で動かす** | 台 A で普通にビルドしたイメージを `docker save` → 台 B（Actions ubuntu-latest）で `docker load` → 実行 → **`exec format error` を実測**。出力全文を保存（撮り逃し厳禁） |
| X-2 | マルチアーキビルド | `docker buildx build --platform linux/amd64,linux/arm64` で作り直し、**台 A（arm64）と台 B（x86_64）の両方で `run-all --dry-run` が成功**する |
| X-3 | Rosetta 実行（参考） | 台 A 上で `--platform linux/amd64` を Rosetta で起動。動くことと**エミュレーションであること**を記録し、実行時間差を参考値として採取（「実機検証済み」とは書かない） |
| X-4 | 配布形態の判断 | レジストリ（ghcr.io private）と `docker save` の tar 受け渡しのどちらを examples の手順にするか。**読者に追加アカウントを要求しない**方を優先して決める |

### 4.4 進行ゲート

1. C-1（手動実行）合格 → cron 章へ
2. C-3（cron 成功）合格 → Docker 章へ
3. D-4（`.ksql` 書込先の結論）確定 → D-5（中断リラン）へ。D-4 が未確定のまま D-5 をやると失敗原因が切り分けられない
4. D-5 合格 → クロスアーキへ

## 5. API 予算

小規模ジョブのみで、1 サイクル概算 **〜60 回**（#3 の S 段階相当）。中断リラン試験を含めても 1 日 **〜300 回**を上限とする。台 B は dry-run のみのため書込消費なし。

## 6. 手順

1. 準備（§3）→ C-1 → **C-2 を必ず「素のまま」で 1 回踏む**（対策を知った状態で最初から回避しない — 一次情報が消える）→ C-3〜C-9
2. D-1〜D-4 → **D-5 の中断試験**（素材採取を最優先）→ D-6〜D-8
3. X-1（失敗の実測）→ X-2（buildx で解決）→ X-3/X-4
4. examples 改訂 → 改訂版で C-3 / D-7 を**もう一度通す**（記事 = examples 一致の担保）
5. 記事 #7 ドラフト起草（§10）

## 7. 成果物

- `examples/cron/` — 起動 sh（絶対パス cd + `.env` 読込）・`/etc/cron.d/ksql` 改訂版・logrotate 設定例
- `examples/docker/` — Dockerfile 改訂（バージョン固定・`.dockerignore`）・`compose.yml`・buildx 手順・read-only / tmpfs の記述
- `verification/linux-docker-notes.md` — 一次記録（版数・コマンド全文・失敗ログ全文・batch_id 対応表）
- 発見課題の起票（`.ksql` の位置設定可能化ほか）
- **Qiita 記事 #7**（§10）

## 8. リスクと対策

- **秘密の露出**: 台 B（public な Actions ログ）には閲覧のみトークンだけを置く。イメージ・ログ・記事素材のマスキングを D-2 で機械的に確認
- **台 A のスリープで cron が不発**: 長時間試験をしない設計（§2）。電源設定を記録
- **arm64 だけで記事を書いてしまう事故**: X-2 の両アーキ成功を Docker 章の掲載条件にする（進行ゲート §4.4-4）
- **実データ更新**: dry-run 中心 + 検証専用 profile。書込を伴うのは D-5 の中断試験のみで、テスト名前空間に限定

## 9. 未決事項

1. **台 C（x86 VPS）を借りるか** — 台 B（Actions）で X-1/X-2 が採れれば不要と判断する。ただし「cron + Docker を実サーバーで通した」と書きたい場合は必要。裁定待ち
2. **Node.js の導入方式** — **Ubuntu 24.04 の apt が配る `nodejs` は 18 系で要件 20.6+ に届かない**ため、候補は NodeSource apt リポジトリ / 公式 tarball / nvm の 3 つ（準備時に `apt-cache policy nodejs` の実出力を記録して、記事でも「素の apt では足りない」を事実として示す）。④'' レンタルサーバー編（tarball 前提）との一貫性を優先するなら tarball。台 A の実測で確定
3. ~~Ubuntu 24.04 LTS で確定してよいか~~ → **確定（2026-08-26・Takashi）**。台 A は Ubuntu Server 24.04 LTS (arm64)。**RHEL 系・FreeBSD は記事の射程外**と冒頭で明記する（実機検証していないものを書かない規約の適用。レンタルサーバー = FreeBSD 系は ④'' が別途扱う）
4. `.ksql` 位置の製品改善を **v0.5 で入れるか、記事では回避策のみ書くか**（D-4 の結果次第）

## 10. Qiita 記事設計（連載 #7）

### 位置づけとタイトル

- ストーリー: 「#6 でサーバーを持たない運用（GitHub Actions）→ **#7 は自分の Linux サーバー / コンテナに載せる**」。#4（Windows）と対になる回
- タイトル案（本命）: **【kSQL Flow #7】cron と Docker で kintone バッチ — M1 で作ったイメージが VPS で動かない**
- 代案 a: 【kSQL Flow #7】cron と Docker で kintone バッチ — 使い捨てのコンテナでも排他とリランが壊れない理由
- 代案 b: 【kSQL Flow #7】Linux サーバーで kintone バッチを毎朝動かす — cron から Docker Compose まで
- **副題は検証後に確定する**。#4 の「0.1 秒で無言死」も #5 の「束ねれば速いが覆った」も一次情報が先にあって決まっている。X-1 が想定どおり出れば本命、出なければ代案 a
- リード案: 「#6 はサーバーを 1 台も持たない話でした。今回は逆に、手元の Linux とコンテナに載せます — M1 でビルドしたイメージを x86 のサーバーに持っていって、一度落としてから。」

### 記事の記法規約（#7 で新設・以降の環境別記事にも適用）

- **コマンドブロックは目的単位で分割し、「ブロック単位で貼り付けてください」を本文に明記する**。#7 は読者が自分のサーバーで打つ手順が主体になるため、一括投入で事故が起きやすい。明記する理由も 1 行添える:
  - 出力を 1 つずつ確認して進むため（`apt-cache policy nodejs` が 18 系を返すこと、`sha256sum -c` が OK を返すこと自体が確認事項）
  - 失敗したらそこで止まって判断するため（一括だと失敗しても後続が走る）
  - 変数を使うブロックは**同一シェル内でないと解決しない**ため、途中で切らない（Node 導入ブロックの `NODE_VERSION` / `WORKDIR`）
- 一括実行用の `setup.sh` を載せるのは、**素の VM で通し再現を取ってから**。載せる場合も「まずブロック単位で理解してから使う」と位置づける
- 検証時のログ取得（`script`）も読者向けに 1 行紹介する — 失敗時の問い合わせ・記録に効く
- 各ブロックの**先頭コメントに番号と目的**を書く（`# --- 2) Node.js 22 LTS（公式 tarball・arm64） ---`）。本文の説明とブロックが 1 対 1 で対応する
- **接続方法・サーバーの準備は記事の射程外**（裁定 2026-08-26・Takashi）。ssh などの接続前提を明記せず、手順は「サーバーのシェルで実行する」とだけ書く。環境は読者が揃えられるものとして扱い、前提条件の列挙で紙面を使わない

### 骨子（検証手順がそのまま章になる）

| 章 | 内容 | 対応する検証 |
| --- | --- | --- |
| 1 | 位置づけ — #4（既存 Windows）/ #6（サーバーを持たない）に対する第 3 の選択肢。cron は「決まった時刻に 1 コマンド叩く起動装置」に徹し、通知・記録・排他・リランはランナーとログアプリが持つ分担表（#4 と同一） | — |
| 2 | cron に登録したら動かなかった — PATH は最小、`.env` は読まれない | C-2 → C-3 |
| 3 | 環境変数と時刻の置き場所 — #6 の Actions は UTC 固定で換算した。自前の Linux は OS 次第（手元の VM は JST・クラウドは UTC 既定が多い）なので、**cron 行に TZ を明示して OS 設定に依存させない** | C-4 / C-5 |
| 4 | ログローテーションと二重起動（Exit 5） | C-6 / C-7 / C-8 |
| 5 | Docker に載せる — イメージに秘密を焼かない・`.ksql` はどこに書くか | D-1〜D-4 |
| 6 | **目玉①: コンテナを kill してもリランで収束する** — ログアプリが正だから、使い捨てでも壊れない（失うものも正直に書く） | D-5 / D-6 |
| 7 | **目玉②: M1 で作ったイメージが x86 で動かない** — `exec format error` から buildx マルチアーキまで | X-1 → X-2（X-3 は注記） |
| 8 | compose + ホスト cron の定石 | D-7 |
| 9 | まとめ — スケジューラが変わっても運用設計は変わらない。次回予告 | — |

### 素材採取計画（後から撮り直せないもの）

| タイミング | 素材 | 用途 |
| --- | --- | --- |
| 準備 | 版数（flow/engine/Node/OS/Docker）・commit・コマンド全文 | 章 1・9 |
| C-2 | **素の cron で落ちた瞬間のログ全文 + syslog の cron 行** | 章 2（目玉の入口） |
| C-5 / C-6 | UTC と JST の発火時刻の実測・ローテ前後のファイル一覧 | 章 3・4 |
| C-7 | Exit 5 で止まったターミナルとログアプリの並び | 章 4 |
| D-4 | `--read-only` で失敗したときのエラー全文 | 章 5 |
| D-5 | **kill の瞬間・直後のログアプリ（RUNNING + last_written_key）・新コンテナでの unlock → --resume → 突合一致** | 章 6（目玉①） |
| X-1 | **`exec format error` の出力全文**（Actions ログのパーマリンク） | 章 7（目玉②） |
| X-2 | buildx の出力と両アーキ成功のログ | 章 7 |
