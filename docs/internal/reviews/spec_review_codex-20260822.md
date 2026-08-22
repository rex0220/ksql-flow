# kSQL Flow リリース版仕様書レビュー（Codex / 2026-08-22）

- 対象: `docs/ksql_flow_spec.md`
- 変換元: `docs/internal/ksql_flow_design_v2_9.md`
- 実装照合: `src/`、`schema/ksql.config.schema.json`、`README.md`、`package.json`、`.github/workflows/ci.yml`、契約テスト
- 検証: `npm test -- --runInBand` = 12 suites / 135 tests PASS、`npm run typecheck` = PASS
- 重大度: BLOCKER（公開仕様の中核契約が成立しない）/ MAJOR（公開前に直すべき契約不一致・利用不能）/ MINOR（誤解・公開品質上の軽微な欠陥）

## 結論サマリ

| 観点 | 結論 |
| --- | --- |
| A. 変換の無損失性 | **PASS** — v2_9 本文の規範は保持され、Q1〜Q7 由来の規範も spec 単体に残っている |
| B. 残存する内部参照・履歴語 | **FAIL** — 冒頭の `docs/internal/`・裁定ログ案内と `POST 課題` が残る。章内参照は解決可能 |
| C. 実装との一致 | **FAIL** — fix5 の主要 8 契約は本文に反映済みだが、CLI fail-closed、heartbeat、lock path、配布形態などに不一致がある |
| D. 初見読者の可読性 | **FAIL** — 付録 A のコピペ不能なコマンド、未完了のリリース前文言、通知/status の局所的な説明不整合がある |
| E. 総合判定 | **不合格（公開前修正が必要）** — BLOCKER 0 / MAJOR 5 / MINOR 5 |

---

## A. 変換の無損失性（最重要）

### 結論: PASS

`git diff --no-index` で v2_9 と spec を全文比較した。本文差分は、(1) タイトル・対応バージョン表記、(2) 冒頭の改訂履歴の削除、(3) 本文中の「裁定 Qn」「申し送り」「旧版では」といった経緯句の除去、(4) 付録 C の削除、に限定される。規範文の削除・弱化・意味変更は確認できなかった。

Q1〜Q7 由来の規範は次のとおり spec 単体に保持されている。

| 由来 | spec の規範 | v2_9 対応箇所 | 実装根拠 | 判定 |
| --- | --- | --- | --- | --- |
| Q1 heartbeat | Exit 0（`NO_DATA` 含む）で送信: spec:134 | v2_9:151、898 | `src/commands/run.ts:148-154`、`src/commands/runAll.ts:375-381`、`src/notify.ts:84-100` | 保持 |
| Q2 依存ホワイトリスト | 依存元が `SUCCESS` / `NO_DATA` のときだけ実行: spec:149 | v2_9:166、899 | `src/commands/runAll.ts:36-40`、`src/commands/runAll.ts:265-272` | 保持 |
| Q3 チェックポイント | 25 チャンクまたは 60 秒、JSONL は毎チャンク: spec:269-271 | v2_9:286-288、900、907 | `src/executor.ts:25-27`、`src/executor.ts:165-195` | 保持 |
| Q4 リトライ列挙 | 429 / 500 / 502 / 503 / 504 / 520 / 522 / 524 / timeout のみ: spec:394 | v2_9:411、901 | `src/http.ts:4-5`、`src/http.ts:67-87` | 保持 |
| Q5 単発 run 構成 | JOB のみ、`parent_batch_id` 空、通知 2 条件: spec:424、469-472 | v2_9:441、486-489、902 | `src/executor.ts:114-125`、`src/commands/run.ts:133-154`、`src/commands/runAll.ts:190-202` | 保持 |
| Q6 filtered / resume | 選抜外を `SKIPPED (filtered)` として記録し resume 対象外: spec:346-353 | v2_9:363-370、903 | `src/commands/runAll.ts:245-255`、`src/commands/runAll.ts:517-575` | 保持 |
| Q7 `last_written_key` | 順序保証なしの診断情報であり復旧位置には使わない: spec:269-271、443 | v2_9:286-288、460、908 | `src/executor.ts:159-195`、`src/executor.ts:299-337` | 保持 |

特に、経緯句を消した結果も「何をするか」「何をしないか」「例外は何か」が残っている。例えば Q4 は「裁定 Q4」を消しても対象ステータスの閉じた列挙と 501 / 505 を含めない規定が維持され、Q7 は旧ウォーターマーク前提を明示的に否定している。この点で変換は無損失である。

なお、以下 C・D の指摘は v2_9 にも既に存在する原設計または実装との不一致であり、公開版への変換によって新たに生じた損失ではない。

---

## B. 残存する内部参照・履歴語

### 結論: FAIL

### B-1. 公開版の冒頭に internal・裁定ログ・レビュー記録への案内が残る

- 重大度: **MAJOR**
- spec: **5-6**
- v2_9: **5-23** の改訂履歴を削除した代わりに新設された文。v2_9 本文の対応規範はない
- 実装・配布根拠: `package.json:31-36` の npm 配布対象に `docs/` は含まれず、npm 利用者にはこの案内先が同梱されない
- 内容: 「履歴・経緯・裁定/申し送り参照を除去した公開仕様」という変換目的に対し、`docs/internal/`、開発版設計書、裁定ログ、レビュー記録を冒頭から案内している。GitHub 上では辿れても、spec が単体配布・転載された場合や npm パッケージ読者には成立しない。公開仕様の正が internal 文書に依存するようにも読める。
- 提案: 5-6 行を削除する。どうしても履歴導線を置くなら、規範本文の外に「参考情報（非規範）」と明記し、公開 URL を指定する。

### B-2. `POST 課題` という内部工程語が残る

- 重大度: **MINOR**
- spec: **308**
- v2_9: **325**
- 実装根拠: `src/commands/unlock.ts:65-75` は v0.1 の解除範囲だけを実装しており、`POST` という公開概念は存在しない
- 内容: 「batchId / jobKey 指定解除は v0.1 では実装せず、POST 課題とします」の `POST` は公開読者に定義されていない内部バックログ分類である。
- 提案: 「将来検討とします」または「v0.1 では非対応です」に置換する。

### 章内・付録参照の検証

`→ 3.4`、`→ 3.6`、`→ 3.7`、`→ 5.1`、`→ 5.3`、`→ 6章`、`→ 8.3`、`→ 9章`、`→ 10.3`、`→ 15章`、付録 A / B、および `5.5-3` はすべて spec 内で解決する。存在しない付録 C、`decisions.md`、申し送り文書、fix 番号、Q1〜Q7、v2.x / v1.0 への参照は残っていない。

外部参照の `kintone-sql-tools 言語リファレンス §27`（spec:211）は spec 内参照ではないが、README のリンク先が存在するため意味は解決可能。ただし公開仕様単体の利便性を上げるなら直接リンクが望ましい。

---

## C. 実装との一致

### 結論: FAIL

fix5 で確定した主要契約の本文反映は概ね正しい。

| fix5 公開契約 | spec | schema / README / 実装 | 判定 |
| --- | --- | --- | --- |
| 未知キー拒否 | 532 | `schema/ksql.config.schema.json:5-18,22-45`、`src/config.ts:159-227`、README:152,158 | 一致 |
| 未知・不適用・競合 flag 拒否 | 581 | `src/cli.ts:32-57,88-124`、README:103,159 | 原則一致。ただし C-1 の例外あり |
| dry-run `formatVersion: 1` | 604-607 | `src/commands/dryrun.ts:33-54,216-238`、`src/commands/runAll.ts:128-145`、README:161,166 | 一致 |
| JSONL envelope / stable events | 456-457 | `src/logging/jsonl.ts:22-35`、`src/executor.ts:150-180,229-237,318-326`、`src/commands/runAll.ts:220-226,366-371`、README:162 | 一致 |
| profile 別 state path / warning fallback | 342-344 | `src/state.ts:31-65`、`src/commands/runAll.ts:517-575`、README:99,163 | 一致 |
| unlock blast radius | 308、576-578 | `src/commands/unlock.ts:13-75`、`src/commands/run.ts:68-78`、`src/commands/runAll.ts:156-165`、README:102 | 一致 |
| clientCert / proxy 非対応 | 543、545 | `src/config.ts:307-328`、`src/runner.ts:42-48`、README:187 | 一致 |
| validate 見積り非対応 | 405、557、697 | `src/commands/validate.ts:19-92`、README:188 | 一致 |

ただし、次の不一致により C 全体は FAIL とする。

### C-1. `--help` が CLI fail-closed 検査を迂回する

- 重大度: **MAJOR**
- spec: **581**（未知 flag・余分な positional は設定読取等より前に Exit 1）
- v2_9: **598**
- 実装根拠: `src/cli.ts:169-177` が `--help` を検出して Exit 0 を返し、`validateArgs` はその後の `src/cli.ts:180-185` でしか呼ばれない
- 再現: `node dist/cli.js run --help --bogus` と `node dist/cli.js run --help extra` は、ともに usage を表示して **Exit 0**。未知 flag / 余分 positional を拒否しない
- README 根拠: README:103,159 も例外なしに未知・不適用 flag / positional の拒否を公開契約としている
- 内容: fix5 の fail-closed 契約に明示されていない例外であり、「全て API 前に拒否」の説明が実装より強い。
- 提案: `--help` の妥当な使い方だけを先に判定するか、command がある場合は `validateArgs` 後に help を表示する。仕様を弱めて例外化するより実装を契約へ合わせるべきである。

### C-2. `notifications.heartbeat.on = "always"` が公開 schema で受理されるが実行時に無視される

- 重大度: **MAJOR**
- spec: **412、521**（heartbeat option と `on: "success"` の例）
- v2_9: **429、538**
- schema / 実装根拠: `schema/ksql.config.schema.json:119-126` は `success | always` を公開値として許可し、`src/config.ts:499-506` も保存する。しかし `src/commands/run.ts:133-155` と `src/commands/runAll.ts:375-399` は成功時だけ heartbeat、失敗時は onFailure のみを呼び、`heartbeat.on` を参照しない。`src/notify.ts:84-100` にも `on` 判定がない
- 内容: `always` を設定しても失敗時 heartbeat は送信されず、受理された公開設定が無効になる。spec も `on` の値域・既定値・意味を定義していないため、spec 単体では設定例を正しく変更できない。Q1 の「Exit 0 では必ず送る」は保持されているが、`always` の契約が欠落している。
- 提案: spec 9 章で `on = success | always`、既定 `success`、各値の送信条件を定義し、実装で `always` を失敗時にも評価する。`always` を v0.1 非対応にするなら schema から削除して未知/不正値として拒否する。

### C-3. ローカルロックの公開 path が実装と異なる

- 重大度: **MINOR**
- spec: **304**（`.ksql/lock`）
- v2_9: **321**
- 実装根拠: `src/lock.ts:14-24` は `.ksql/lock-<sanitized-profile>.json`
- 内容: profile ごとに独立する実装に対し、spec は単一固定ファイルに見える。障害調査や手動確認時に利用者が誤った path を探す。
- 提案: `.ksql/lock-<profile>.json` と profile 正規化規則を明記する。

### C-4. v0.1 の二系統配布を規定するが、単一実行バイナリの生成・検証経路がない

- 重大度: **MAJOR**
- spec: **708**
- v2_9: **725**
- 実装・配布根拠: `package.json:27-42` は Node.js 用 `dist/cli.js` と TypeScript build のみ、`.github/workflows/ci.yml:32-60` も npm tarball の pack/install smoke のみ。Windows 単一バイナリの build script、成果物、checksum 生成・検査 job はない
- 内容: 公開時の仕様の正が「npm とチェックサム付き単一実行バイナリの二系統」と断定しているが、現リポジトリの v0.1.0 実装・CI は npm 系統しか裏付けない。
- 提案: 公開前に binary build・checksum・release smoke を実装するか、v0.1 の配布を npm のみに限定し、単一バイナリを将来予定へ移す。

### C-5. JSONL の「必ず記録」保証が実装の best-effort より強い

- 重大度: **MINOR**
- spec: **382-383、455**
- v2_9: **399-400、472**
- 実装根拠: `src/logging/jsonl.ts:31-35` は append 失敗を無通知で握りつぶし、再送キューも `src/logging/jsonl.ts:59-66` で保存失敗を握りつぶす
- 内容: ディスク read-only、容量不足、権限エラー時には「必ず記録」「次回自動再送」は成立しない。実装はジョブ継続を優先した best-effort である。
- 提案: 実装で警告を出し、契約を「可能な限り記録。失敗時は警告し、実行は継続」に変更する。監査上 fail-closed が必要なら、逆に JSONL 保存失敗で実行停止する規定と実装が必要。

---

## D. 初見読者の可読性

### 結論: FAIL

冒頭の対応表記 `ksql-flow v0.1.0 / engine ^3.71.0 / dialect 1`（spec:3）は簡潔で適切であり、README:176-182、`package.json:2-3,44-46` と一致する。一方、冒頭の internal 案内は B-1 の理由で不適切である。

### D-1. 付録 A のセットアップ例が実コマンド名ではなく、コピペすると失敗する

- 重大度: **MAJOR**
- spec: **742-743、753-758、765-768、773-778**
- v2_9: **759-760、770-775、782-785、790-795**
- 実装根拠: `package.json:27-29` が提供する bin は `ksql-flow` のみ。実際の同梱例は `examples/github-actions/daily-batch.yml:14-15`、`examples/windows-task-scheduler/run_batch.bat:6-7`、`examples/cron/ksql.cron:1-2`、`examples/docker/Dockerfile:3-7` で正しく `ksql-flow` を使う
- 内容: spec:554 は本文例の `ksql` を略記と宣言するが、付録 A は「セットアップ例」であり、npm install 直後に存在しない `ksql` を実行している。特に Docker の JSON-form `CMD` は説明用疑似コードではなくコンテナ entrypoint なので確実に `executable file not found` になる。
- 提案: 付録 A の全コマンドを `ksql-flow` に変更する。略記は SQL/動作説明だけに限定し、セットアップ・CI・Docker・cron・bat では実コマンドを使う。

### D-2. リリース版に「初期リリース前に実測」「初期リリース時に更新」が残る

- 重大度: **MINOR**
- spec: **454、640-645**
- v2_9: **471、657-662**
- 実装根拠: `src/logapp.ts:38-49` は約 55,100 文字での安全側切り詰めを実装しているが、65,535 文字の実測結果を公開契約として記録していない。`.github/workflows/ci.yml:10-60` に性能測定 job はなく、spec:644-645 の性能値を裏付ける常設検証もない
- 内容: v0.1.0 のリリース版なのに、未完了のリリース前 TODO を読者へ露出している。性能表も「目標」なのか「実測」なのか確定していない。
- 提案: 実測して値・環境・日付を記載するか、「参考目安（未保証）」へ明確に格下げし、将来更新を示す工程語を削除する。

### D-3. `SKIPPED` と「通知しない」の最初の説明が後続仕様より狭い

- 重大度: **MINOR**
- spec: **135、392**
- v2_9: **152、409**
- 実装根拠: `src/commands/runAll.ts:245-281,298-320` では `SKIPPED` に filtered / dependency / stop-on-error / batch-timeout / LOCKED があり、`src/commands/run.ts:148-154` と `src/commands/runAll.ts:375-381` は `NO_DATA` でも heartbeat を送る
- 内容: spec:135 は `SKIPPED` を「依存ジョブの失敗による未実行」とだけ括弧定義するが、直後と 6.3 / 8.2 では複数理由がある。spec:392 の「通知しない」も、3.2 の注記を離れて読むと heartbeat まで送らないように見える。
- 提案: `SKIPPED` を「未実行（理由は 8.2 の reserved reason）」と定義し、7.1 の通知欄も「onFailure は送らない。heartbeat は Exit 0 として送る」に統一する。

### 用語の導入順

- BYOC は初出で展開されており良好。
- heartbeat、`last_written_key`、`filtered` は正式節より前に現れるが、その場で短い意味説明と後続節参照があるため致命的ではない。
- `updateKey`、MCP の「ネットワーク 0 契約」、`Dashboard Pro` は初見読者には唐突。公開仕様を製品単体で完結させるなら、用語集または外部リンクがあるとよい。ただし今回の合否を左右する独立指摘にはしない。

---

## E. 総合判定

### 結論: 不合格（公開前修正が必要）

変換の最重要要件である規範の無損失性は満たしている。しかし「v0.1.0 公開時の仕様の正」としては、次の MAJOR 5 件が残るため合格にできない。

| ID | 重大度 | 修正必須事項 |
| --- | --- | --- |
| B-1 | MAJOR | 冒頭の internal / 裁定ログ / レビュー記録への依存的な案内を削除または非規範の公開 URL に変更 |
| C-1 | MAJOR | `--help` で未知 flag / positional 検査を迂回できる実装を fail-closed 契約へ合わせる |
| C-2 | MAJOR | heartbeat `on: always` の意味を spec に定義し実装する、または schema から拒否する |
| C-4 | MAJOR | Windows 単一バイナリ配布を実装・検証するか、v0.1 の配布仕様から外す |
| D-1 | MAJOR | 付録 A の実行コマンドをすべて `ksql-flow` に修正 |

重大度集計は **BLOCKER 0 / MAJOR 5 / MINOR 5**。

残る MINOR は B-2（`POST 課題`）、C-3（lock path）、C-5（JSONL の絶対保証）、D-2（未完了の実測文言）、D-3（局所説明の狭さ）の 5 件。

### 再レビューの合格条件

1. MAJOR 5 件をすべて解消する。
2. B の再検索で `裁定|申し送り|fix[0-9]|decisions.md|付録 C|Q[1-7]|PRE-|POST|v2.` が 0 件になる（製品バージョン `v0.1` 等は除外）。
3. 付録 A の全実行例が `package.json` の bin 名と一致する。
4. CLI 契約について `run --help --bogus` と `run --help extra` が Exit 1 になる回帰テストを追加する。
5. heartbeat の `success / always` を両方テストし、spec・schema・runtime の三者を一致させる。
6. `npm test -- --runInBand`、`npm run typecheck`、npm pack/install smoke を再実行する。単一バイナリを v0.1 に残す場合は、その生成・checksum・Windows smoke も追加する。
