# README 公開前レビュー（Codex / 2026-08-22）

- 対象: `README.md`（fix5 / fix6 反映後の作業ツリー）
- 想定公開面: GitHub リポジトリ / npm package `@rex0220/ksql-flow@0.1.0`
- 検証制約: 実 kintone への通信なし。ローカル CLI、ソース、テスト、schema、spec、pack 内容を照合した。
- 重大度: **BLOCKER** = README だけでは公開時の主要導線を完走できない、**MAJOR** = 公開契約・コマンド説明・リンクが誤解または失敗を生む、**MINOR** = 公開品質・構成上の改善。

## A. 導線の実効性（最重要）

### 結論: **FAIL（BLOCKER）**

README のコマンド例そのものは現行 CLI の基本構文に合うが、必要な秘密値の設定、配布物の取り出し、clone 時の導入方法が欠け、README だけを上から歩いて両文脈で完走する導線にはなっていない。

### 机上歩行

| 手順 | npm `-g` 利用者（examples 非同梱） | GitHub clone 利用者 | 判定・根拠 |
| --- | --- | --- | --- |
| 1. install | README:29-32 の `npm i -g @rex0220/ksql-flow` は `package.json:24-28` の Node 18+ / bin 契約と一致。`npm pack --dry-run --json` でも `dist/cli.js` を確認した。 | README は同じ registry 版の global install しか示さない。clone した作業ツリーを使う `npm ci && npm run build` + `node dist/cli.js`、または `npm i -g .` のどちらもない。`dist/` は `.gitignore:3`、build は `package.json:39` なので fresh clone に実行物はない。 | npm: **PASS**。clone: **MAJOR**（registry 版併用なら進めるが、clone 自体の導入方法がない）。README:34 の隣接エンジン作業ツリー説明は代替にならない。 |
| 2. config 作成 | README:38-56 の最小 JSON を保存する指示は成立する。 | 同左。 | **途中まで PASS**。ただし README:49-50 の `env:KSQL_TOKEN_*` を OS ごとにどう設定するかがない。実装は空・未定義を直ちに ConfigError にする（`src/config.ts:85-93`）。実 CLI でも未設定 token により API 呼び出し前 Exit 1 を確認した。 |
| 3. ログアプリ作成 | pack には `template/ksql-flow-log-template1.zip` と `template/README.md` が入る（`package.json:31-36`）が、global install 後にそのファイルを見つけるコマンドもダウンロードリンクも README:71-73 にない。後段 README:170 の相対リンクまで探せば GitHub 上の説明へ行ける想定だが、Quickstart の手順自体は作業ディレクトリ相対 `template/` としか読めない。 | clone には `template/` があり成立する。 | npm: **BLOCKER**。clone: **PASS**。少なくとも Quickstart 内にテンプレート ZIP の GitHub download link、または installed package path の取得方法が必要。 |
| 4. log app validate | README:74 の `validate --check-logapp --profile prod` は allowlist と dispatch に一致（`src/cli.ts:33-48,193-203`）。 | 同左。 | **構文 PASS**。ただし token 環境変数、実 app ID への差替え、業務アプリ token の必要権限が未案内なので、前段が補われない限り完走不能。 |
| 5. job validate | README:77 は現行構文。掲載 SQL（README:60-64）は `apps` を渡した `parseScript` で `UPDATE` 1 文として診断なしを確認した。runner `validate` は schema 依存検証を行う（`docs/ksql_flow_spec.md:67`、README:85）。 | 同左。 | **構文 PASS**。実 kintone schema 検証は制約により未実行。README は `顧客マスタ` の閲覧・編集 token と、例示フィールドコード `処理済み` の置換を明示すべき。 |
| 6. dry-run | README:78 は run の allowlist に一致（`src/cli.ts:36-40`）。DML は preview、read-only 文は実行という説明も `src/commands/dryrun.ts:64-68` / `docs/ksql_flow_spec.md:588-610` と一致。 | 同左。 | **構文 PASS**。読み取り API は実消費するので、有効な業務アプリ token がない現状導線では到達不能。 |
| 7. run | README:79 は run の allowlist に一致。 | 同左。 | **構文 PASS**。前段の欠落を利用者が補えた場合のみ完走する。 |

### A の修正要求

1. **[BLOCKER] README:66-79 を自己完結させる。** Bash と PowerShell の最低限の環境変数設定例、placeholder の app ID / field code を自環境へ置換する指示、業務アプリ token の閲覧・編集権限、ログ token の閲覧・追加・編集権限を、最初の `validate` より前に置く。
2. **[BLOCKER] npm 利用者がログアプリ template を取得できるリンクまたはコマンドを README:71-73 に置く。** `template/README.md` という相対パスだけでは global install 利用者の現在ディレクトリに存在しない。
3. **[MAJOR] GitHub clone 用 install を README:27-35 に分離して追加する。** registry global / clone の2経路を明記し、README:34 の engine 開発者向け説明は contributor 文書へ移す。

## B. 正確性

### 結論: **FAIL（MAJOR 4 件、MINOR 1 件）**

fix5 / fix6 の heartbeat、resume、dry-run、Exit Code、互換表、主要な Public contracts baseline は実装・spec と一致している。一方、CLI 表示、公開参照先、リンクに公開前修正が必要である。

### 一致を確認した項目

- **heartbeat: PASS** — README:151 の `success`（`SUCCESS` / `NO_DATA`）と `always` は `schema/ksql.config.schema.json:119-126`、`src/config.ts:486-506`、`src/notify.ts:84-104`、`docs/ksql_flow_spec.md:413` と一致。fix6 で裁定参照も本文から除去された。
- **resume: PASS** — README:99 の対象、元 as-of、`SKIPPED (filtered)` 除外、profile 別 state fallback は `docs/ksql_flow_spec.md:342-353` と `src/commands/runAll.ts:516-569` に一致。
- **dry-run: PASS** — README:100,105-120 の DML preview、副作用範囲、sample 1..50、API 上限 Exit 3 は `docs/ksql_flow_spec.md:584-610` と実装に一致。README:166 の `DRY_RUN` / `DRY_RUN_BATCH` field 列も `src/commands/dryrun.ts:33-54,216-236`、`src/commands/runAll.ts:130-147` と一致。
- **Exit Code: PASS** — README:129-140 は `docs/ksql_flow_spec.md:612-628`、`src/types.ts:12-21`、`src/commands/runAll.ts:476-491` と一致。API 上限を Exit 3 とする追記も `docs/ksql_flow_spec.md:609` と整合する。
- **互換表: PASS** — README:176-182、`docs/ksql_flow_spec.md:3`、`package.json:44-46`、隣接 engine の `package.json` はいずれも Flow 0.1.0 / engine ^3.71.0 / dialect 1。
- **Public contracts baseline: おおむね PASS** — config unknown-key reject、CLI allowlist、22-field template、dry-run JSON formatVersion、JSONL envelope、profile 別 state は schema / runtime / `docs/ksql_flow_spec.md:344,457-458,582,605-608` と合う。`npm pack --dry-run --json` は dist / schema / template / README / LICENSE の26ファイルを収録し、examples / docs は非同梱だった。テストは **13 suites / 146 tests PASS**。

### 指摘

#### B-1. 「共通フラグ」が実装の command allowlist と矛盾する

- 重大度: **MAJOR**
- README: README:96
- 根拠: 実装の真の共通フラグは `--profile` / `--config` / help のみ（`src/cli.ts:32-48`）。`--max-api-calls` / `--lock` / `--force-unlock` は run / run-all 専用で、validate / validate-all / unlock / init-logapp では API・config 読込前に Exit 1（`src/cli.ts:88-117`）。README:103 自身の「command 別 allowlist」とも矛盾する。
- 修正: README:96 を「run / run-all 共通フラグ」に変え、真の全 command 共通フラグを別記する。

#### B-2. `validate -f ... [--check-logapp]` は「両方を検証する」構文ではない

- 重大度: **MAJOR**
- README: README:85
- 根拠: `--check-logapp` があると dispatch は直ちに `checkLogAppCommand` を返し、`-f` の SQL は検証しない（`src/cli.ts:193-203`）。現在 allowlist は併用を受理するため、README の1行 synopsis は特に誤解を招く。
- 修正: `validate -f <file.sql> [--strict]` と `validate --check-logapp` を別行にする。可能なら CLI 側も `-f/--file` と `--check-logapp` の併用を競合として拒否するが、本レビューでは実装変更を行わない。

#### B-3. 公開契約の詳細参照先が非公開配布面の内部設計版になっている

- 重大度: **MAJOR**
- README: README:160,166,170
- 根拠: README:166 は「設計書 v2.9 §10.2」を参照するが、公開の正は `docs/ksql_flow_spec.md` であり、同じ nested shape は `docs/ksql_flow_spec.md:584-610` にある。npm tarball は docs を含まない（`package.json:31-36`）。README:160 の裸の `§8.2` と README:170 の「設計書 8.2」も公開読者には参照先が曖昧。
- 修正: すべて `[公開仕様書 §8.2](docs/ksql_flow_spec.md#...)` / `[公開仕様書 §10.2](docs/ksql_flow_spec.md#...)` に統一する。npm ページで anchor が正しく rewrite されることを publish 後 smoke する。

#### B-4. `examples/ksql.config.json` の GitHub link は公開後も切れる

- 重大度: **MAJOR**
- README: README:68-69,144
- 根拠: ファイルはローカル作業ツリーにはあるが、`.gitignore:12` の `ksql.config.json` が basename match して `examples/ksql.config.json` も無視する。`git check-ignore -v` は同規則を報告し、`git ls-files --error-unmatch examples/ksql.config.json` は未追跡を返した。pack にも examples はない（`package.json:31-36`）。したがって GitHub URL と相対 link の双方が公開物に存在しない。
- 修正: `.gitignore` に `!examples/ksql.config.json` を追加して追跡するか、秘密値を含まない別名（例: `examples/ksql.config.example.json`）へ変更し、README の2箶所を一致させる。

#### B-5. Public contracts の `reserved reason` が未定義で実装集合も尽くしていない

- 重大度: **MINOR**
- README: README:160
- 根拠: README は reserved reason とだけ書く。`docs/ksql_flow_spec.md:451` は `filtered / LOCKED / dependency: x / stop-on-error 等`、実装はそれに加えて `batch-timeout` を生成する（`src/commands/runAll.ts:258-280,429-463`）。「reserved」が閉じた集合なのか例示なのか判別できない。
- 修正: 公開契約にする理由を列挙して extension rule を定義するか、公開契約を `SKIPPED (` prefix と `filtered` / `LOCKED` の意味に限定する。

### バッジ・リンク検査

- CI badge（README:3）は repository metadata（`package.json:7-13`）と tracked workflow `.github/workflows/ci.yml` に対して構造上正しい。
- README の他の tracked relative target（schema、template、spec、internal docs、LICENSE、Windows example）はローカルに存在する。ただし npm tarball 内には docs / examples がなく、installed README を直接読む場合はそれらの相対 path は存在しない。
- GitHub repository / npm package はレビュー時点で公開前のため live HTTP 表示は確定できなかった。公開直後に badge、全 README link、npm の relative-link rewrite、release / package URL を smoke する必要がある。少なくとも `examples/ksql.config.json` は上記 B-4 により現状のまま確実に切れる。

## C. 内部語の残存

### 結論: **FAIL（MAJOR 1 件）**

fix6 により本文の「裁定 Q1」は除去され、README 全体に `fixN` / `Phase` / `PRE-` / `POST-` / `decisions.md` は残っていない。しかし、公開版の正ではない内部成果物と開発経緯を読者向け一次導線に残している。

#### C-1. 内部設計版・申し送り・調査資料が公開の正と同列に並ぶ

- 重大度: **MAJOR**
- README: README:34,166,197
- 内容:
  - README:34 の「隣接するエンジン作業ツリー」「結合確認」は contributor 向けで、install と Quickstart の間に置く公開利用者の前提ではない。
  - README:166 の「設計書 v2.9」は内部版番号であり、公開仕様の版体系を迂回する。
  - README:197 の「エンジンからの申し送り」「開発経過 (docs/internal)」「実装前調査報告」は、公開利用者が製品契約を理解するための一次資料ではない。
- 修正: README のドキュメント欄は公開仕様書・言語リファレンス・CHANGELOG・LICENSE に限定する。内部資料を公開する方針自体は `docs/ksql_flow_spec.md:6` の非規範注記で足りる。engine-local 手順は contributor 文書へ移す。

## D. 構成と分量

### 結論: **NEEDS CHANGE（MAJOR 1 件、MINOR 2 件）**

節の大枠は「概要 → install → Quickstart → command / contract summary → operational notes」の順で良い。202行 / 約17KBは npm README として過大ではないが、最初の実行導線に contributor 情報が割り込み、Quickstart の不足を後段の詳細節で補わせている。

1. **[MAJOR] 行動順を2経路で明示する。** README:27-35 を「npm global」「GitHub clone」に分け、各経路を template 取得まで閉じる。README:34 は削除または contributor 文書へ移動する。
2. **[MINOR] as-is 宣言は可視性を保ちつつ短くする。** README:7-19 の日英13行はリスクの高い DML ツールとして冒頭掲載の意図は妥当。ただし npm の first view で value / install を押し下げるため、冒頭は日本語+英語の2〜4行要約にし、完全な説明を後段「Support / Warranty」へ移すのがよい。
3. **[MINOR] 重複を圧縮する。** dry-run は README:100、105-120、122-127、Public contracts:161,166 に重複する。README は Quickstart + 安全上重要な副作用/API消費 + JSON top-level summary に絞り、nested shape は公開 spec §10.2 へ委譲する。ログ/排他も同様に contract summary を残し詳細は spec へ送る。

## E. 総合判定

### 結論: **公開不可（FAIL）**

集計: **BLOCKER 2 件 / MAJOR 7 件 / MINOR 3 件**（A の導線修正と B〜D の指摘を重大度別に集計。B-4 は A の参照先欠陥とも関係するが別契約面として計上）。fix5 / fix6 の runtime 契約反映自体は概ね正しく、heartbeat の裁定参照除去も成功している。しかし、公開の顔として最重要の「README だけで初回実行」がまだ成立しない。

### 公開前の必須修正（優先順）

1. **[BLOCKER]** Quickstart に env 設定、placeholder 差替え、業務/ログ app token 権限を追加する。
2. **[BLOCKER]** npm global 利用者が template ZIP を取得できる直接リンクまたは再現可能なコマンドを Quickstart に追加する。
3. **[MAJOR]** ignored / untracked の `examples/ksql.config.json` を公開物として追跡できる名前・ignore 設定に直し、README:69,144 のリンクを修正する。
4. **[MAJOR]** npm global / GitHub clone の install 手順を分離し、engine-local 開発説明を外す。
5. **[MAJOR]** README:96 の flag 区分を CLI allowlist と一致させ、`validate -f` と `validate --check-logapp` を別 synopsis にする。
6. **[MAJOR]** internal design v2.9 / 申し送り / 開発経過 / 調査報告を一次導線から除き、公開 spec の section link に統一する。
7. **[MINOR]** `SKIPPED` reason の公開範囲を定義し、dry-run nested shape と冒頭 as-is 文を圧縮する。

### 再レビューの合格条件

- fresh temp directory で pack install 相当を行い、README の npm 手順だけで config 作成 → template 取得 → `validate --check-logapp` 直前まで到達できる。
- fresh clone で README の clone 手順だけを実行し、`ksql-flow --help`（または明記した local invocation）が Exit 0 になる。
- `git ls-files examples/...config...` が README の参照先を返し、`npm pack --dry-run --json` と GitHub / npm live README の全リンク smoke が通る。
- 実 kintone を使う公開判定では、README の順に log app check → job validate → dry-run → run を staging profile で1回完走する。

## 実施したローカル検証

- `node dist/cli.js --help` / command help / allowlist の否定例（`run --json`、`validate-all --check-logapp`）
- README 掲載 SQL の `parseScript(..., { apps })`
- env 未設定の `validate --check-logapp` が API 前 Exit 1 になること
- `npm pack --dry-run --json`（26 files、template/schema 同梱、examples/docs 非同梱）
- `npm test -- --runInBand`（13 suites / 146 tests PASS）
- README relative target の存在確認、`git check-ignore` / `git ls-files`、隣接 engine v3.71.0 の read-only 照合
- 実 kintone 通信・ファイル実装変更は未実施
