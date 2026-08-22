# kSQL Flow v0.1.0 公開直前 全体アーキテクチャレビュー（Codex）

- 実施日: 2026-08-22
- 対象: `docs/ksql_flow_design_v2_8.md`、`src/`、`test/`、README / CHANGELOG / examples / template / CI / package metadata、`docs/internal/` の裁定・検証記録
- 前提: `docs/internal/reviews/decisions.md` Q1〜Q7 は裁定済みとして固定し、再提案していない
- 制約: 実 kintone への通信なし、`../kintone-sql-tools` の参照・変更なし
- 検証: `npm test -- --runInBand` = **9 suites / 101 tests PASS**、`npm run typecheck` = **PASS**、`npm run build` = **PASS**。`npm pack --dry-run --json` は sandbox 外の `C:\npm-cache` への書込みが `EPERM` となり今回の再検証は未成立（package 内容の失敗ではない）。テンプレート ZIP は展開せず .NET Zip API で `template.json` を読み、22 カスタムフィールド・`job_key unique`・status 選択肢を確認した。

## エグゼクティブサマリ

コアの実行モデルは健全である。エンジン責務を `/flow` 公開 API に限定し、HTTP 単一カウンタ、二層ロック、冪等リラン、ログアプリを正とする resume、dry-run の副作用遮断まで、一連の安全設計は実装・101 テスト・Phase 0 実機記録で相互に裏付けられている。Q1〜Q7 の裁定も現行コードに定着している。

一方、**現状のまま v0.1.0 を公開する判定は不可**とする。理由は細かなバグ数ではなく、初回公開で固定される次の契約境界が未確定または危険なためである。

1. CLI が未知フラグをエラーにせず無視する。特に `--dryrun` の typo が dry-run ではなく本実行へ進み得る（`src/cli.ts:32-58,186-204`）。データ更新 CLI の fail-safe 契約として公開前に必須修正。
2. 正本 §9.1 は client certificate / proxy を「初期リリースから対応」とするが、実装と README は ConfigError による未対応を契約としている（設計書 §9.1 / `src/config.ts:229-250` / `src/runner.ts:42-48` / README「制限事項」）。また正本 §7.2・§10.1・§14 の validate 時 API/所要時間見積りは実装されていない（`src/commands/validate.ts:48-62`）。正本と製品のスコープを公開前に一意化する必要がある。
3. config / `--json` / JSONL / state の「公開契約か内部形式か」の線引きが不足している。config は JSON Schema がなく未知キーを黙認し、JSON/JSONL は schema version を持たず、文書上の `.ksql/state.json` と実体 `state-<profile>.json` が異なる（`src/state.ts:31-41`）。初版公開前が最も安価に境界を決められる時点である。
4. `--check-logapp` は型と `job_key unique` は検査するが、`record_type` / `status` の選択肢を検査しない（`src/commands/initLogapp.ts:86-103`）。8.2 の語彙と `log_detail` 前方一致は resume を含む外部契約なので、「検査 OK」が保証する範囲を実体に合わせる必要がある。

以下では、指摘を **公開前に対処**、**公開後の課題台帳**、**記録のみ（良い点・設計判断の妥当性確認）** の三区分で記載する。

---

## A. 仕様 ⇔ 実装の全体マッピング

### A-1. 章別棚卸し

| 設計書 | 主な実装・公開物 | 状況 | 差分・暗黙仕様 | 区分 |
| --- | --- | --- | --- | --- |
| §3 SQL 方言・単一ジョブ | `src/jobs.ts`、`src/executor.ts`、エンジン `/flow`、examples/jobs | **概ね整合** | ASSERT / EXIT / warning / dialect / 20 文上限 / LAPP / UPSERT・MERGE はエンジン公開 API に委譲し、ランナーは結果写像に専念。将来 `SYNC` は §3.4 で将来構文と明記済み。`LOCKED` をログ上 SKIPPED とする裁定も一致（`src/types.ts:1-10`, `src/commands/runAll.ts:296`）。 | 記録のみ |
| §4 オーケストレーション | `src/jobs.ts:45-96`、`src/commands/runAll.ts` | **機能は整合、構造は集中** | ファイル順、depends_on、3 モード、Q2 伝播は実装済み。設計上の orchestrator が独立モジュールでなく 574 行の command に、選抜・ロック・state・ログ・通知まで集中。`--parallel` 未対応は README に明記済み。 | 公開後 |
| §5 実行・整合性・ロック | `src/executor.ts`、`src/http.ts`、`src/lock.ts`、`src/logapp.ts` | **概ね整合** | 100 件単位の engine callback、25 chunk / 60 秒、as-of、timezone、二層 lock、fail-closed を実装。`last_written_key` の Q7 定義も一致。ローカルロックの実体は文書の `.ksql/lock` でなく `.ksql/lock-<profile>.json`（`src/lock.ts:14-25`）。`unlock` / `--force-unlock` は同 profile の全 RUNNING を解除するが、その blast radius は公開文書にない（`src/commands/unlock.ts:31-40`, `src/commands/run.ts:70-75`）。 | 公開前（文書・対象範囲） |
| §6 リラン | `src/commands/runAll.ts:514-573`、`src/state.ts`、`src/logapp.ts:262-288` | **意味論は整合、形式差あり** | Q6 の filtered 前方一致、未着手、元 as-of、ログアプリ優先は一致。設計書・README は `.ksql/state.json`、実装は profile ごとの `state-<profile>.json`。最大 500 JOB の query 固定で、501 件以上のバッチは resume が全件取得できない（`src/logapp.ts:277-283`）。 | パスは公開前、500 件は公開後 |
| §7 エラー・上限・通知 | `src/errors.ts`、`src/http.ts`、`src/notify.ts`、`src/runner.ts` | **実行時は整合、事前見積り欠落** | Q4 retry、Retry-After、jitter、単一 HTTP count、timeout、failure / heartbeat は実装済み。§7.2 の「validate / EXPLAIN が推定 API と所要時間を出す」は validate にない。JSONL / pending 書込み失敗を握りつぶすため、§7 の「必ず記録」はディスク障害時には保証されない（`src/logging/jsonl.ts:21-27,51-58`）。 | 見積りは公開前、監査劣化は公開後 |
| §8 ログ・監視 | `src/logapp.ts`、`src/logging/*`、template ZIP | **フィールド実体は整合、契約検査不足** | 22 フィールド、親子、Q5、切詰め、mask、pending resend は実装。SKIPPED prefix は生成と resume 判定が一致（`src/commands/runAll.ts:441-461,536`）。ただし check-logapp は dropdown options を検査せず、JSONL event schema / 保持期間 / rotation は未定義。 | check は公開前、JSONL運用は公開後 |
| §9 config | `src/config.ts`、`examples/ksql.config.json`、README | **重大な仕様差** | apps / tokens / extends / env / limits / retry / notifications / logging / password / Basic 併送 / guestSpace は実装。clientCert / proxy は正本では初期対応、実装では明示拒否。未知キーを無視し、正式な JSON Schema がない。`auth.type: basic` と `basicAuth` 併送の入力形も正本の例だけでは一意でない（`src/config.ts:293-331`）。 | 公開前 |
| §10 CLI / dry-run / Exit | `src/cli.ts`、`src/commands/*` | **主要機能は整合、parser 契約は不合格** | dry-run の `DRY_RUN` / `DRY_RUN_BATCH`、sample、mask、Exit 0〜5 は整合。未知 flag を黙認。`--resume|--from|--only` は排他表記だが同時指定を拒否せず、resume の as-of を取得後 only/from が selection を上書きする（`src/commands/runAll.ts:90-125`）。`--json` は dry-run 以外でも受理して人間向け出力になる。validate の見積りも欠落。 | 公開前 |
| 付録 A 実行環境 | `examples/github-actions`、windows、cron、docker | **GitHub 上は整合** | 4 環境はいずれも実コマンド `ksql-flow` を使用。設計書の `ksql` は §10.1 で略記と宣言済み。ただし npm package の `files` に examples が含まれず、global install 直後の README にある `cp examples/ksql.config.json` は成立しない（`package.json:31-36`, README「クイックスタート」）。 | 公開前（README） |
| 付録 B ログアプリ | `template/ksql-flow-log-template1.zip`、`src/commands/initLogapp.ts` | **実装済み** | ZIP 内 template は 22 カスタム field、status 7 値、record type 2 値、job_key unique。init / check も提供。ただし template version と Flow version の互換・更新方針、および check の option 検査が不足。 | check は公開前、upgrade 方針は公開後 |
| 付録 C 決定履歴 | `docs/internal/reviews/decisions.md`、fix1〜4 review | **整合** | Q1〜Q7 は実装・テストへ反映済み。再提案対象なし。 | 記録のみ |

### A-2. 未実装・暗黙仕様・食い違いの結論

**未実装で明記不足**:

- validate / validate-all の推定 API 消費・推定所要時間（設計書 §7.2, §10.1, §14。実装 `validateScript` の診断のみ）。README もこの欠落を縮退・未対応として明示していない。
- config の client certificate / proxy は README では明記されるが、仕様の正では「初期リリース対応」のまま。
- local JSONL の event vocabulary、schema compatibility、retention。監査証跡として掲げる一方、利用者が依存してよい範囲が未定義。

**実装済みだが設計書にない暗黙仕様**:

- state / local lock は profile ごとのファイル名。これは複数 profile の同一 workspace 運用には妥当だが、仕様へ昇格すべき。
- `unlock` / `--force-unlock` は job / batch 指定でなく profile 全 RUNNING を解除。
- resume / unlock のログ取得は 500 レコード上限。
- `httpTimeoutMs`、`basicAuth` という config 入力面は実装に存在するが、正本の config 例・キー表として整理されていない。

**食い違い**:

- clientCert / proxy、state path、validate 見積りが主要な仕様差。
- §8.3 は JSONL を「必ず」記録するとするが、logger は書込み例外を無通知で握りつぶす。
- README のインストール文脈と examples の配布範囲が一致しない。

**A の結論**: コア実行意味論は高い整合度に達しているが、公開面を含む完全マッピングでは **公開前に解消すべき仕様差が残る**。特に §9 と §10 を現行実装へ合わせるか実装を正本へ合わせるかを一意に決めるまで、v2.8 を「仕様の正」として公開できない。

---

## B. アーキテクチャの健全性

### B-1. モジュール境界と依存方向

| 境界 | 評価 | 根拠 |
| --- | --- | --- |
| config | 良好 | ファイル読込・extends・env・型検証を集約。通信層に依存しない（`src/config.ts`）。ただし schema 定義が TypeScript interface / 手書き validator / README の三重管理。 |
| http | 良好 | retry、timeout、API count、Basic header、dry-run mutation guard を単一 fetch decorator に集約（`src/http.ts:35-116`）。bulkRequest 導入後も「HTTP request 数」という単位は維持できる。 |
| executor | やや過密 | engine statement loop だけでなく、分散 job lock、log field 構築、checkpoint、mask、git ref、status 分類まで保持（`src/executor.ts:82-338`）。executor が config / http / logapp / JSONL / mask を直接知る。 |
| orchestrator | 機能はあるが境界なし | 独立 `orchestrator.ts` はなく、`runAll.ts` が DAG 選抜、dry-run、batch lock、state、JOB loop、aggregation、通知、resume を一括所有。現在の順次 MVP には動くが、parallel scheduler 導入時の変更面が広い。 |
| logapp | 概ね良好 | kintone record I/O と lock / resume query を集中。反面、分散 lock repository と audit repository が同じ class で、将来 backend 差替えや bulk log write をしにくい。 |
| lock | 良好 | ローカル O_EXCL と owner batchId 付き release は単純で安全。profile 全体粒度と distributed job 粒度の差は文書化が必要。 |
| state | 良好（内部 cache として） | schemaVersion 1、atomic rename、read failure fallback は妥当（`src/state.ts:9-55`）。ただし path と migration / corruption 表示が未契約。 |
| notify | 良好 | failure / heartbeat と payload を実行本体から分離。通知失敗が batch outcome を上書きしない判断も妥当。 |
| dryrun | 概ね良好 | `/flow` の preview / execute を単一 context で分岐し、副作用 guard は HTTP に再委譲。ただし DML type 文字列集合と `keyFields` 抽出が engine AST shape に直接依存。 |

依存循環は検出しない。外側の command が runner environment を組み立てる方向は妥当である。ただし `executor` が永続化の詳細を知り、`dryrun` が `RunnerEnvBundle` に依存し、`runAll` が全ユースケースを抱えるため、domain/application/infrastructure の境界は薄い。v0.1.0 の規模では許容できるが、次の大機能を同じ形で足すべきではない。

### B-2. エンジン公式 API への結合度

**良い点**:

- 全 import は `@rex0220/kintone-sql-tools/flow` であり、内部 path import はない（`src/jobs.ts`, `src/runner.ts`, `src/executor.ts`, commands）。package は `^3.71.0`、lock は 3.71.0、README の互換表とも一致。
- `isDmlResult` / `FlowDmlResult`、`FlowChunkWrittenInfo`、metrics snapshot、`PreviewResult` は申し送り v3.70 / v3.71 の明示公開契約を使用している。
- HTTP は injected fetch だけを介し、API count / retry / dry-run guard がエンジン内部へ漏れない。

**グレーな依存**:

- checkpoint の伏字判定は AST `statement.type` と `statement.keyFields` を直接参照する（`src/executor.ts:400-407`）。dry-run も `keyFields` を unknown cast で読む（`src/commands/dryrun.ts:295-302`）。現時点では `/flow` export の型に含まれるため禁止依存ではないが、ランナー内の二箇所へ AST knowledge が分散している。
- DML 判定の文字列 set（`src/commands/dryrun.ts:19-20`）は新しい engine DML variant の追加で更新が必要。未知 DML は HTTP mutation guard で fail-closed になる点は安全だが、compatibility error は利用者に分かりにくい。
- ASSERT の分類は安定対象と回答された `AssertError` に依存（`src/executor.ts:252-255`）しており妥当。その他の engine error code 値域へは依存していない。

公開後の改善として、engine adapter 1 モジュールに「DML 判定・key field・result/status 写像・engine capability」を集約し、major upgrade の contract test をそこへ置くのがよい。

### B-3. 将来拡張耐性

- **`--parallel`**: DAG 情報と依存 satisfied set は再利用可能。一方、`runAll.ts` の逐次 for-loop、単一 state file への同期 write、batch/job log 更新、stop mode、global API counter を scheduler から分離する必要がある。実装前に `JobScheduler` と `JobRunRepository` 相当の境界を作るべき。API counter を batch 全体共有する設計は並列でも正しいが、上限到達時の in-flight request cancel / drain 規則を仕様化する必要がある。
- **bulkRequest**: HTTP 実測カウンタはそのまま利用可能。変更が必要なのは engine の `onChunkWritten` の意味、原子性・`last_written_key`・estimatedWrites 表示とテスト。現在の runner は「100」という定数で chunk を分けておらず、耐性は比較的高い。
- **E-2 拡張**: Preview adapter の戻り値は discriminated data へ写像済み。unchanged や field normalization を加える際は `DryRunReport` の additive field として schema version / compatibility rule が先に必要。
- **engine major**: `^3.71.0` は major 4 を自動取得しないため即時破壊は防げる。adapter contract test と README compatibility matrix 更新を release checklist の常設項目にすれば十分対応可能。

**B の結論**: **v0.1.0 のコアとしては健全**で、全面 rewrite は不要。最も大きな負債は orchestrator 境界の欠如と engine AST knowledge の分散であり、parallel または engine major 対応の前に返済すべき。これは現行の公開を単独で止める理由ではない。

---

## C. 公開後に変えにくい公開契約の安定性評価（最重要）

### C-1. 契約面ごとの判定

| 面 | 契約 / 内部の推奨線引き | 現状評価 | v0.1.0 で固定可否 |
| --- | --- | --- | --- |
| `ksql.config.json` | キー名・型・default・extends・env・null semantics・未知キー処理は**公開契約**。resolved object は内部。 | 文書例と手書き validator はあるが JSON Schema なし。未知キー無視は typo、とくに `stripLiterals` 等で危険。clientCert / proxy の正本差あり。 | **不可** |
| CLI command / flags | command、flag、排他関係、default、stdout/stderr、Exit Code は**公開契約**。parser 実装は内部。 | Exit 0〜5 は良好。未知 flag 黙認、selection flags 非排他、`--json` 単独黙認、`--version` なし。 | **不可** |
| log app 8.2 | 22 field code/type、status / record_type vocabulary、job_key unique、JOB/BATCH linkage、SKIPPED prefix は**永続公開契約**。label/layout/view は template UX で、意味論上は変更可。 | 実装・ZIP は一致。check が option vocabulary を保証しない。field migration/version 方針なし。 | **条件付き可** |
| `log_detail` SKIPPED prefix | `SKIPPED (` 先頭と reserved reasons (`filtered`, `LOCKED`, `dependency:`, `stop-on-error`) は**公開契約**。後続の人間向け説明は追加可。 | writer と resume の `startsWith("SKIPPED (filtered)")` が一致しテストあり。文字列 parser 依存は意図的に文書化済み。 | **可** |
| `--json` | dry-run の top-level kind、status / exit、jobs、counts、samples の型は**公開契約**。人間向け表示は契約外。 | `kind` discriminant は良いが schemaVersion なし、全 shape の公開表なし。normal run での `--json` 意味が未定義。 | **不可** |
| local JSONL | `ts`, `event`, run/batch correlation、mask guarantee、encoding は最低限の**監査契約**。各 event payload の追加 field は additive、内部 debug event は best-effort と線引きすべき。 | event 名と payload は code のみ。schemaVersion なし。一部 event は batchId を payload に持たず filename に依存。write error は無通知。 | **不可（線引き未定）** |
| state | path、profile isolation、schemaVersion、破損時挙動は運用上の契約。jobs の細部は**内部 cache**で、手動編集非対応と明記してよい。 | schemaVersion は良い。文書 path 不一致、未知 version / parse failure を無言で null 扱い。 | **条件付き可** |
| template ZIP | file 名、対応 Flow version、22 field contract、job_key unique は**配布契約**。layout / view は変更可。 | 現物は整合。ZIP 名 `template1` は version を示すが compatibility / upgrade 説明なし。check options gap。 | **条件付き可** |
| package / runtime | package 名、bin、Node engines、engine compatibility、files は**公開契約**。内部 source layout は契約外。 | metadata と engine matrix は整合。Node >=18 を宣言するが CI は 20/22 のみ（`.github/workflows/ci.yml:12-24`）。examples は package 外。 | **条件付き不可** |

### C-2. 公開前に必要な最小契約化

1. `docs` または README に「Public contracts in v0.1」を設け、上表の線引きを明記する。内部扱いにするものも明示する。
2. config の JSON Schema を 1 つ正として、runtime validation と editor / CI 利用へつなぐ。少なくとも未知キーを Exit 1 にする。clientCert / proxy は、v0.1 から外すなら正本 §9.1 を README と同じ制限へ修正する。
3. CLI は command ごとの allowlist で未知 / 不適用 flag、余分な positional、競合 flag を実行前に Exit 1。`--dryrun` typo が real run へ落ちないことを回帰テストにする。
4. JSON は `schemaVersion: 1`（または `formatVersion`）を top-level に持たせ、DRY_RUN / BATCH の exact shape と additive change rule を明記。`--json` は `--dry-run` 専用として拒否するか、normal run の形も定義する。
5. JSONL は全 event 共通 envelope（version / ts / event / batchId / profile）を決める。全 event payload を永続契約にしたくない場合は、安定 event と debug event を区別する。
6. state は `.ksql/state-<profile>.json` を正として文書を修正するのが安全（複数 profile を上書きしない実装判断は妥当）。破損 / unsupported version の警告を出し、手動編集非対応を契約化する。
7. check-logapp で record_type / status options も検査し、template と `LOG_APP_FIELDS` の機械突合を CI に入れる。
8. Node 18 を CI matrix に加えるか、engines を実際に CI する最小版へ上げる。

**C の結論**: 最重要観点として **現状は固定不可**。実装のコア品質ではなく、外部が依存する format / typo fail-safe / schema boundary が未完成である。初回公開後に schemaVersion や unknown-key rejection を入れる方が互換問題を生むため、公開前に最小契約を確定すべき。

---

## D. 運用シナリオの通し歩行

### D-1. 初回導入

1. `npm i -g @rex0220/ksql-flow`、config 作成、template から log app 作成、token 発行、`validate --check-logapp`、job validate、dry-run、run の順序は README で明快。
2. template を推奨し init-logapp を password-only の代替にした導線は現実的。Phase 0 で実 log app / Windows scheduler を確認済みなのも強い。
3. 穴: global install の直後に `cp examples/ksql.config.json` と案内するが npm package に examples はない。GitHub URL から取得する手順、または README 内の最小 config を保存する手順へ直す必要がある。
4. 穴: clientCert / proxy が必要な企業環境は、正本を読むと初期対応に見えるが実行時に Exit 1。採用判断を誤らせる。
5. 穴: `--check-logapp` の OK が dropdown vocabulary を保証しないため、初回本実行で status write が失敗し得る。

### D-2. 日次運用

1. run-all の先頭表示、job ごとの status / counts / API、BATCH/JOB、heartbeat、scheduler Exit は一貫している。
2. depends_on と独立 job の扱い、stop / continue、Q2 white list は運用者の予測可能性が高い。
3. 穴: local JSONL に retention / rotation / disk full alert がなく、長期運用で `.ksql/logs` と pending が無制限に増える。ログアプリ成功済み JSONL の保存期間を利用者が決める手順が必要。
4. 穴: `--version` がなく、障害受付や監査で CLI 実体の版を即確認できない（ログ app の `ksql_version` は実行後に限る）。
5. 穴: GitHub Actions / Docker examples が latest install のため、日次運用が意図せず新 version へ更新される。運用例は `@0.1.0` pin と Renovate 等による明示更新を推奨すべき。

### D-3. 障害

1. transient retry、Retry-After、API cap、timeout、fail-closed、mask、failure webhook、Exit 分類はよく設計されている。
2. 部分適用時に冪等 UPSERT / MERGE と same as-of resume を案内する UX は妥当（`src/commands/run.ts:157-167`）。
3. 穴: JSONL append と pending enqueue の失敗を両方握りつぶすため、ログ app と disk が同時障害のとき「証跡がない」こと自体が出力されない。少なくとも stderr の強い警告と final status / health indicator が必要。
4. 穴: API count に log / lock を含む設計上、上限到達後の finish log 自体が発行前に拒否され、JSONL / pending へ落ちる。これは安全だが、利用者向けに「ログアプリは RUNNING のまま、次回 stale/unlock が必要になり得る」運用説明が薄い。

### D-4. 復旧

1. `--resume` がログアプリを正とし、state fallback、as-of 引継ぎ、filtered 除外、未着手再実行を行う流れは強い。Phase 0 実機で query operator 差を発見・修正した記録もある。
2. 穴: `unlock` と `--force-unlock` は同 profile の全 RUNNING を TIMEOUT 化する。他 host の有効な別 job まで解除し得るため、実行前の確認手順・対象表示・blast radius を文書化し、可能なら batchId / jobKey target を導入する。
3. 穴: 501 JOB 以上は log query の `limit 500` で resume / unlock の完全性が崩れる。現状のスケール上限として文書化するか cursor/paging を実装する。
4. 穴: state file の実 path が文書と違うため、障害調査時に運用者が見つけにくい。

### D-5. 監査

1. actor / host / git ref / as-of / engine+flow version / counts / error / detail を揃えた 22 field は十分。JOB/BATCH の親子と単発 JOB-only の裁定も監査上明確。
2. log_detail の SKIPPED prefix は機械と人の両方が読める最小契約として妥当。
3. 穴: JSONL の共通 correlation / schema version / retention、template migration、field contract version がない。監査ツールが v0.1 の現物へ直接依存すると将来変更できない。

### D-6. CLI UX

- 良い点: command 名、`-f`、profile/config、as-of、dry-run/sample/json、lock、Exit 表示は概ね一貫。エラーメッセージは具体的で復旧ヒントもある。
- 公開前問題: unknown / command-inapplicable flag の無視は、単なる UX ではなく安全性の欠陥。`--dryrun`、`--strcit`、`--stop-on-eror` を拒否すべき。
- 公開前問題: `--resume`, `--from`, `--only` の排他を実装で保証する。`--sample` / `--json` は dry-run 専用、`--check-logapp` は validate 専用等、command ごとの usage error を統一する。
- 公開後改善: `--version`、`--help` の command 別詳細、machine-readable error（必要なら stderr JSON）を検討。

**D の結論**: happy path と主要障害復旧は公開水準に近い。体験の最大の穴は **CLI typo が安全側に倒れないこと**、次いで unlock の広い対象、監査 format / retention、導入文脈と package 内容の不一致である。

---

## E. テスト戦略の全体評価

### E-1. 現状の強み

- 101 tests は config、validate、HTTP retry / cap / Basic、run、dry-run、locking、run-all、resume、secrets、examples を横断する。単体だけでなく engine 実体 + mock kintone の結合形である。
- 安全性の中核（業務 mutation 0 の dry-run、fail-closed、API 上限、secret 4 surfaces、job_key lifecycle、Q1〜Q7）がテストされている。
- 250 件 3 chunk、3 chunk 目失敗、UPSERT SELECT key mask、metrics delta など、engine 公開 API の実データ形を固定している。
- Phase 0 で actual kintone の validate → dry-run → run、ASSERT、NO_DATA、double-run、resume、Webhook、Windows Task Scheduler を通している。mock だけでは得られない価値が高い。

### E-2. 偏りと既知ギャップ

1. **CLI parser / public contract テストがほぼない**: 未知 flag、余分な positional、command 不適用 flag、selection flag 競合、`--version`、stdout/stderr separation のテストがなく、今回の fail-open を許した。
2. **mock の kintone fidelity**: Phase 0 で DROP_DOWN に `=` を受理する mock と実 kintone の差が顕在化した。現在は IN query の文字列検査を追加したが、mock parser を通ることと実 API が受理することは同値でない。dropdown options、guest path、query escaping、500 件 paging、preview app deploy なども同様。
3. **artifact contract のテスト不足**: template ZIP ⇔ `LOG_APP_FIELDS`、package file list、installed tarball CLI、README command、JSON schema / JSONL schema / state migration の常設テストがない。`examples.test.ts` は SQL validate 1 本が中心。
4. **runtime matrix の偏り**: package は Node >=18、主要 target は Windows だが、CI は Ubuntu Node 20/22 のみ。Windows は Phase 0 の一点確認で、将来回帰を防がない。
5. **failure injection の不足**: disk full / permission loss、corrupt pending/state、log write と local write の同時失敗、process kill の実プロセス境界、notification timeout、500 超の resume/unlock を守るテストがない。
6. **scale / concurrency の不足**: batch 内 500+ jobs、複数 host 相当、parallel 将来の API cap競合、large log truncation / Unicode length、pending queue 大量再送が未検証。
7. **config schema の不足**: unknown key、unknown nested key、deprecated key、default snapshot がない。type/interface と validator と docs の drift を検出できない。

### E-3. 公開後の回帰防御として追加すべき層

**公開前に追加**:

- CLI parser table test: 全 command × allowed flags、unknown / typo / conflict / extra args は Exit 1、特に typo dry-run が execution path に入らない。
- public contract snapshot/schema test: config JSON Schema examples、DRY_RUN / BATCH JSON schema、JSONL envelope、state version。
- template contract test: ZIP の template.json を read-only parseし、22 code/type/options/unique と `LOG_APP_FIELDS` を比較。
- CI Node 18（または engines 修正）、`npm pack --dry-run` / tarball install smoke、package `--help` / `--version` / offline parse smoke。

**公開後 P1**:

- Windows CI smoke（path / encoding / bin shim）、optional real-kintone release gate checklist の常設化。
- query compatibility fixture を actual kintone の受理規則から作り、mock 独自文法だけで正しさを判定しない。
- disk/state/pending corruption、500+ paging、unlock target、log truncation の failure/scale tests。
- engine adapter contract suite を作り、対応 engine version ごとに AST / metrics / preview / chunk contract を実行。

**E の結論**: 101 件は機能安全性に厚く、数として不足しているのではない。偏りは **公開契約・CLI parser・artifact・実プラットフォーム差** にある。v0.1.0 の回帰防御として、上記「公開前に追加」の 4 層が必要。

---

## F. 総合判定

### F-1. 公開可否

**判定: 現状のままは公開不可（条件付き GO の手前）**。

データ実行、ロック、resume、dry-run、logging の基本アーキテクチャを理由に止めるものではない。公開を止めるのは、初版で外部が依存する CLI/config/JSON/log-app 契約が一意でなく、かつ未知 flag 黙認が real mutation へつながるためである。次の「公開前に対処」を完了し、101 tests に契約テストを足して再検証できれば、全体 architecture として v0.1.0 の公開を許可できる。orchestrator 分割や大規模 refactor は公開条件にしない。

### F-2. 公開前に対処

| ID | 優先度 | 課題 | 完了条件 |
| --- | --- | --- | --- |
| PRE-1 | **P0 / release blocker** | CLI fail-open | command ごとの flag allowlist。未知・不適用・競合・余分 positional を API call / file mutation 前に Exit 1。`--dryrun` typo 回帰テスト。`--resume|--from|--only` 排他。normal run の `--json` を拒否または契約化。 |
| PRE-2 | **P0 / release blocker** | 正本 v2.8 と scope の一意化 | clientCert / proxy を v0.1 非対応へ正本修正するか実装。validate の API/時間見積りを実装するか、v0.1 非対応として正本・README・CHANGELOGへ明記。裁定 Q1〜Q7 は変更しない。 |
| PRE-3 | **P0 / release blocker** | public contract baseline | config JSON Schema / unknown-key error、JSON format versionと exact shape、JSONL stable envelope または明示的 internal 線引き、state の profile別 path・schema/破損挙動を文書化。 |
| PRE-4 | **P0 / release blocker** | log app contract verifier | check-logapp が record_type / status option 集合と job_key unique を検査。template ZIP と code の CI contract test。 |
| PRE-5 | **P1 / release gate** | distribution/runtime promise | Node 18 を CI するか engines を上げる。pack dry-run + tarball install smoke を CI 化。README の examples copy 手順を package 実体に合わせる。 |
| PRE-6 | **P1 / release gate** | destructive recovery UX | unlock / force-unlock が profile 全 RUNNING を対象にする現状を help / README に明記し、実行前に対象一覧を表示。可能なら batch/job target を追加。 |

### F-3. 公開後の課題台帳

| ID | 優先度 | 課題 | 方向性 |
| --- | --- | --- | --- |
| POST-1 | P1 | orchestrator 境界 | `runAll.ts` から selection/DAG scheduler、batch repository、aggregation/notification policy を分離。`--parallel` 前に実施。 |
| POST-2 | P1 | engine adapter | DML type、AST keyFields、result/status mapping、capability を 1 adapter に集約し engine version contract test を置く。 |
| POST-3 | P1 | 500件 paging | listBatchJobs / listRunning を cursor または paging 化。完了までは最大 job 数を制限事項へ。 |
| POST-4 | P1 | local audit durability | JSONL / pending write error を可視化し、disk full 時の status policyを決める。retention / rotation / cleanup recipe を提供。 |
| POST-5 | P1 | Windows / real API regression | Windows CI smokeと、資格情報を要する実 kintone release gate の再現可能な checklist を常設。DROP_DOWN 等 query compatibility を mock 外で守る。 |
| POST-6 | P2 | template migration | template version ⇔ Flow compatibility、field additive migration、既存 app upgrade / check / repair 手順を定義。 |
| POST-7 | P2 | CLI observability | `--version`、command-specific help、必要なら machine-readable error envelope。RUNNER_VERSION の package version との二重管理を解消。 |
| POST-8 | P2 | scale/performance evidence | §11 の目標値を実測へ置換。large temp、large log、pending resend、Unicode truncation、500+ jobs を計測。 |
| POST-9 | P2 | reproducible ops examples | GitHub Actions / Docker の package version pin、明示 upgrade recipe、checksum / provenance 方針。 |

### F-4. 記録のみ（良い点・妥当性確認）

- engine と runner の repository / responsibility 分離、`/flow` 公開 API のみへの依存は妥当。
- Q1 heartbeat、Q2 whitelist、Q3/Q7 checkpoint、Q4 retry list、Q5 JOB-only、Q6 filtered の裁定は、現行の運用安全性を高めており変更不要。
- `maxApiCalls` を logger / lock / retry を含む injected HTTP で一元計測する構造は、将来 bulkRequest でも単位を維持できる。
- dry-run を engine preview と runner HTTP guard の二重遮断にし、lock/logapp/state を呼出経路から除外した設計は強い。
- template ZIP の現物、code の 22 fields、README のフィールド説明は一致している。
- package の engine range `^3.71.0` と README compatibility matrix、lock の 3.71.0 は一致している。
- 101 tests と Phase 0 実機記録は、v0.1.0 のコアが机上設計だけでないことを十分示す。

### 最終結論

**大局的には「中核は公開可能、公開契約は未完」**である。PRE-1〜PRE-5（加えて PRE-6 の最低限の文書化）を公開ゲートとして閉じれば、v0.1.0 は as-is 製品として妥当な初回リリースになる。逆に、それらを残して公開すると、最初の利用者が config typo、CLI typo、JSON parser、log app field、state pathへ依存した後に互換修正が必要になり、今回の主題である「公開後に変えにくいもの」の負債を初日に固定してしまう。
