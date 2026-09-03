# kSQL-Flow Contract v1.1（IMPORT source 配線）実装計画

* 作成: 2026-09-03（Codex）
* 対象: `@rex0220/ksql-flow` 0.7.0 から 0.8.0（予定）
* 要求の正: `../ksql-flownet/docs/internal/csv-io-implementation-plan.md` §3.1
* engine 契約: `../kintone-sql-tools/docs/internal/flow_import_source_api_spec.md`、ローカル main `ee8d6cb`（`743b7c8`を含む v3.75.0 release commit）
* 状態: **実装可能。ただし `input_files[].rows` だけは §4.1 の engine 公開 API 追加が release gate**

---

## 0. 結論

Contract v1.1 は、既存の orchestrator 専用 `run` 経路へ named IMPORT source を純加法で接続する。CLI は repeatable な `--import-csv` / `--import-json` を収集し、orchestrator mode では同じ source 集合に対する `--expected-import-sha256` を必須にする。`src/commands/run.ts` から `src/executor.ts` まで型付き source 定義を渡し、engine の公開 `createImportSourceResolver` と `enableImport: true` だけで parse、validate、execution を行う。engine 内部 CLI、非公開 `ExecuteOptions`、型 cast による option 注入は使わない。

orchestrator mode は、SQL が参照する全 source を最初の SQL 文より前に open 済み handle から読み、engine に返すものと同一の `Uint8Array` から sha256 / bytes を算出して期待値と照合する。照合済み bytes は loader cache に保持し、engine へ同じ object を返す。standalone mode も同じ loader 実装を使うが、期待 hash は省略でき、IMPORT 文へ到達した時点で遅延読込みする。`--import-encoding` は設けず、文字コードの正は SQL `ENCODING UTF8|SJIS`、次に loader metadata、最後に UTF-8 とする。

Execution Result の `input_files` は additive property とし、絶対 path や内容を含めない。ただし、2026-09-03 時点の engine v3.75.0 公開 API は RFC 4180 解析後の入力行数を返さない。`StatementResult.rowCount` は IMPORT source 行数の契約ではなく、`StatementResult.result` も IMPORT 固有情報を安定公開していない。このため改行数の自前計算や engine 非公開 module の import は採用せず、§4.1 の最小公開 receipt を engine に追加してから `features.importCsv: true` を開放する。

## 1. 現状調査（実コード、2026-09-03）

### 1.1 `run` の option 伝播

現行の伝播は次のとおりである。

```text
src/cli.ts
  parseArgs: Map<string, string | boolean> へ格納（同じ flag は後勝ち）
  validateArgs: command 別 allowlist と orchestrator 4 flag の all-or-none 検査
  runOptionsFromArgs
    -> RunOptions
      -> runCommand
        -> standalone / orchestrator 分岐
          -> loadJobFile
          -> runJob(RunJobParams)
```

* `src/cli.ts:22-42,90-113`: 値付き flag は単一 `Map` に保存される。同じ flag を繰り返すと最後の値で上書きされるため、IMPORT 3 flag はこのままでは repeatable 契約を満たさない。
* `src/cli.ts:50-61`: `run` の allowlist に IMPORT flag はない。`run-all` も同様である。上流 §3.1 は単一 `run` を対象とするため、0.8.0 では `run` だけへ追加し、`run-all` へ暗黙拡張しない。
* `src/cli.ts:354-376`: `runOptionsFromArgs` は scalar option だけを返す。IMPORT source collection と期待 hash の伝播口を追加する必要がある。
* `src/commands/run.ts:27-51`: `RunOptions` / `OrchestratorRunOptions` に source 定義がない。
* `src/commands/run.ts:161-168,330-347`: `runJob` 呼出しへは source 情報が渡らない。
* `src/executor.ts:44-62`: `RunJobParams` に resolver、source receipt、IMPORT capability がない。

`loadJobFile` も配線対象に含める必要がある。`src/jobs.ts:23-40` は `parseScript(source, { apps })` を即時実行して `JobFile.parsed` を作るため、`executor.ts` だけに `enableImport: true` を追加しても、その前に IMPORT が `KSQL1202` になる。`loadJobFile` に additive な parse option を設け、`run` の IMPORT 対応経路は source 未供給時も `enableImport: true` で parse して、後段で `ImportSourceNotSuppliedError` として判定する。

### 1.2 Execution Result の組立て

* `src/commands/run.ts:264-438`: orchestrator 専用経路が `executionId`、開始状態、失敗分類を保持し、最後に `normalizeJobOutcome` を呼んで `writeExecutionResult` へ渡す。standalone は Execution Result を出力しない。
* `src/commands/run.ts:470-518`: config 読込や CLI validation など `runCommand` 到達前の controlled failure も synthetic outcome にして schema-valid な結果を出す。
* `src/contract/executionResult.ts:63-89,109-129,157-200`: TypeScript の正規化境界。現在は input file metadata を受け取る context field も、結果 property もない。
* `schema/execution-result-v1.schema.json:7-65`: root は `additionalProperties: true` で additive field を許すが、producer の canonical schema と型には `input_files` を明示する必要がある。既存 required property は維持する。
* `src/contract/executionResultWriter.ts:14-25`: stdout は JSON object 1 個 + LF、path 出力は同一 directory の一時 file、fsync、rename で完成させる。`input_files` 追加後もこの writer をそのまま使う。

失敗時の receipt を失わないため、source registry は `runOrchestratedCommand` の try より長い寿命で生成し、`finally` 後の正規化時に `snapshotInputFiles()` を渡す。startup failure では空配列、複数 source の途中で失敗した場合は engine が materialize 完了を通知済みの source までを source 名順で返す。

### 1.3 orchestrator mode 判定

orchestrator mode は専用 subcommand ではない。

* `src/cli.ts:176-216`: `--result-json`、`--correlation-id`、`--attempt-id`、`--expected-job-id` の4つを全指定した `run` が orchestrator mode になる。部分指定は Exit 1。
* `src/commands/run.ts:59-67,218-259`: command 層でも同じ all-or-none を再検査し、dry-run、JSON/sample、`--lock local-only`、logApp 不在、既存 result path を拒否する。
* `src/commands/run.ts:288-319`: profile / job ID / logApp field / local lock を検査し、`src/executor.ts:261-288` の最初の `executeStatement` 直前にだけ `executionStarted=true` を通知する。

`--expected-import-sha256` は5つ目の mode 判定 flagにはしない。mode は既存4 flagでのみ決め、orchestrator mode かつ supplied source がある場合に source/hash 集合の1対1を要求する。これにより IMPORT を使わない既存 orchestrator 呼出しは後方互換となる。

### 1.4 `capabilities` の構造

`src/commands/capabilities.ts:7-31` は config 読込・kintone 通信なしで、format/version、Execution Contract、schema ID、固定 `features` object を stdout に1 JSON objectとして出す。0.8.0 の完成 build でだけ同じ object に `importCsv: true` を追加する。部分実装中は false を返すのではなく property 自体を追加せず、release commit で全 gate 通過後に追加する。`importJson` は FlowNet が要求する capability ではないため新設しないが、`importCsv: true` を出す build は standalone JSON も同じ loader 層で利用可能でなければならない。

### 1.5 engine と依存の現状

* 本リポジトリの `package.json` / lock / `node_modules` は engine 3.74.0。`npm run dev:engine-local` は package/lock を変えず `file:../kintone-sql-tools` を `node_modules` に一時適用する既存方式である。
* 隣接 engine main は `ee8d6cb` で、B177 実装 `8b34e80`、review fix `bad44fb`、指定 commit `743b7c8` を含む v3.75.0 release commit まで進んでいる。公開 npm 利用可否とは分けて扱う。
* v3.75.0 は `ImportEncoding`、`FlowImportSourcePayload`、`FlowImportSourceLoader`、`FlowImportSourceResolver`、`FlowNamedImportSource`、`FlowImportProviderError`、`createImportSourceResolver`、`enableImport?`、`importSource?` を `/flow` から公開する。
* source 名は helper が完全一致・case-sensitive で扱い、重複は `ImportSourceDuplicateError`。未供給、read、非通常 file、payload不正、10 MiB超にも安定 code があり、source failure時の mutation API は常に0。capability 省略/false は `KSQL1202` のままである。

## 2. Contract v1.1 の CLI と型

### 2.1 repeatable flag の保持

`ParsedArgs` に repeatable 値を失わない専用領域を追加する。

```ts
interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
  repeatedFlags: Map<string, string[]>;
}
```

`REPEATABLE_VALUE_FLAGS` を `--import-csv`、`--import-json`、`--expected-import-sha256` に限定し、`--flag value` と `--flag=value` の双方で出現順に append する。既存 scalar flag の後勝ち挙動は本件で変更しない。`repeatedStringFlags()` 以外の既存 helper が配列を受けない構造にして波及を抑える。

各 source 指定は最初の `=` だけで分割する。これにより path 内の `=` を保持する。検査規則は次のとおりとする。

| 入力 | 規則 | 失敗 |
| --- | --- | --- |
| source name | 空を拒否。SQL parser が返す name と完全一致で比較。CLI 表現は安全な非制御文字に限定し、NUL/CR/LFを拒否 | Exit 1、API/file open前 |
| path | 空を拒否し、`path.isAbsolute` を要求。相対 path、NUL を拒否 | Exit 1 |
| sha256 | source name と64桁 ASCII hex。比較前に小文字へ正規化 | Exit 1 |
| 重複 | CSV内、JSON内、CSV/JSON間、expected内の完全一致名を全て拒否。後勝ちにしない | Exit 1 |

backtick identifier を含む複雑な SQL 名も engine AST 上の実名と完全一致で照合できるよう、CLI 側で英数字だけの独自 identifier regex は設けない。FlowNet 自身はより狭い schema を採用できる。ログ安全性は表示時の allowlist と制御文字拒否で担保する。

### 2.2 command/executor 間の型

新規 `src/importSources.ts` に path と lifecycle を閉じ込め、`RunOptions` と `RunJobParams` は次の安全な定義を受け渡す。

```ts
type ImportKind = "CSV" | "JSON";

interface ImportSourceInput {
  readonly name: string;
  readonly kind: ImportKind;
  readonly absolutePath: string;       // process内限定。結果・ログへ渡さない
  readonly expectedSha256?: string;
}

interface InputFileReceipt {
  readonly name: string;               // source name。pathではない
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly encoding: "UTF8" | "SJIS";
}
```

`RunOptions.importSources` から `RunJobParams.importSources` へ配列のまま渡す。pathを `JobOutcome.detailLines`、JSONL、通知 payload、Execution Result error messageへ混ぜない。`RunOptions` は programmatic test API でも同じ重複・集合検査を通し、CLIだけを信用しない。

### 2.3 mode別規則

| 規則 | standalone `run` | orchestrator `run` |
| --- | --- | --- |
| `--import-csv` / `--import-json` | repeatable、同一 loader | repeatable、同一 loader |
| expected sha256 | 省略可。指定された場合は照合する | supplied CSV/JSON 全件と1対1で必須 |
| hash欠落/余剰/重複 | 指定集合に矛盾があれば実行前エラー | 実行前エラー |
| SQL source未供給/種別不一致 | 実行前エラー | 実行前エラー、`executionStarted=false` |
| suppliedだがSQL未使用 | stderr / JSONLへ安全なsource名だけで警告、実行継続 | stderrのみへ警告しstdout純度維持。Execution Resultには載せない |
| file読込 | IMPORT到達時のlazy load | 全ての使用sourceをSQL開始前にpreload/hash照合 |

orchestrator では JSON も受理する以上、期待 hash はCSVだけでなく supplied CSV/JSON の和集合へ1対1で要求する。FlowNet段階1はCSVだけを生成するため上流利用に差はなく、JSONだけ検証を弱める例外も作らない。

SQL AST の `statement.type === "IMPORT"` と `statement.source.kind/sourceName` を `/flow` の公開 `Statement` 型から読み、要求 source 集合を作る。同名を複数文から参照すること自体は許可し、kindが食い違う場合だけ実行前エラーにする。文字列検索やSQL再parserは実装しない。

## 3. loader と実行配線

### 3.1 file lifecycle と TOCTOU 対策

各使用 source は次の state machine を持つ。

```text
DECLARED -> OPENED -> BYTES_VERIFIED -> MATERIALIZED -> CLOSED
              \-> FAILED ---------------------------> CLOSED
```

1. `fs.promises.lstat(absolutePath)` で symbolic link、directory、device、socket等を拒否し、通常 fileだけを許可する。
2. `fs.promises.open(path, "r")` 後、handleの `stat()` でも通常 fileであることを再確認する。以後は path を再度 `readFile` せず、その handleから読む。
3. engine 上限が10 MiBであるため、最大 `10 MiB + 1 byte` まで読み、超過を engine にも渡して `ImportSourceTooLargeError` を正規の最終判定にする。事前 size だけを信用しない。
4. 取得した単一 `Uint8Array` から `crypto.createHash("sha256")` と `byteLength` を求める。hash対象と engine payload を別読みにしない。
5. expected hash があれば `timingSafeEqual` 相当の固定長比較を行い、不一致なら engine loader / kintone mutationへ進めない。
6. bytesを cacheし、`createImportSourceResolver` に渡す loader の `load()` は同じ bytes objectを返す。JSONにencoding metadataは付けず、CSVもCLI default encodingを捏造しない。SQL句なしならengine既定UTF-8になる。
7. 成否にかかわらず handle を閉じる。cacheは1 job終了時に参照を破棄する。

`FlowImportProviderError` は非通常 fileを `ImportSourceNotRegularFileError`、open/read failureを `ImportSourceReadError` に分類する。公開結果へ渡す message は source名と固定要約だけとし、絶対 path、OS message、stack、causeを載せない。standalone の人間向け診断も本契約では安全なsource名までとし、path詳細が必要なら debug用の秘密保護済みローカル診断を別設計にする。

### 3.2 parse、validate、execution の単一路

IMPORT sourceありの `run` は次の順序に統一する。

```text
CLI syntax/duplicate
  -> loadJobFile(parseScript(..., {apps, enableImport:true}))
  -> ASTから要求source/kind抽出
  -> supplied/expected集合の完全検査、unused警告
  -> createImportSourceResolver（重複をengine helperでも二重検査）
  -> validateScript(source, {apps, client, strict, enableImport:true})
  -> orchestratorのみ使用sourceをpreloadしsha256照合
  -> createExecutionContext({..., enableImport:true, importSource})
  -> 最初のonExecutionStart / executeStatement
  -> 文ループ
  -> dispose / handle close
  -> Execution Result
```

`runJob` は現在 parse diagnostics だけを確認しており、本実行時に `validateScript` を明示実行しない。Contract v1.1 では IMPORT 経路に限らず既存 run の意味を変えないよう、`params.importSources !== undefined` のときに full validation を追加する。ここでも同じ `enableImport: true` を使い、エラーなら最初の SQL 文前に Exit 1とする。将来全runをfull validationへ統一する変更は別issueとする。

orchestrator preload と full validation は `executionStarted` hook より前に置く。hash欠落・余剰・不一致、source未供給、通常 file違反では `executionStarted=false`、count類0、mutation 0のExecution Resultを返す。hash不一致の additive `resultCode` は FlowNet側計画に合わせ `INPUT_FILE_MUTATED`、Exit 1、category `CONFIG` とし、それ以外のCLI/source集合不備は `VALIDATION_ERROR` のまま `error.code` で区別する。

### 3.3 rows、encoding、receipt

sha256 / bytes は kSQL-Flow loaderが確定し、rows / effective encoding は engineが内容をdecode/materializeした結果だけを採用する。receiptは source name でjoinし、次を全て満たした sourceだけ `input_files` に確定する。

* engine loaderへ同一bytesを返した
* engineのCSV RFC 4180 parserまたはJSON materializerが完了した
* engineから source名、data row数、effective encoding の公開通知を受けた

CSV rows はheaderを除くdata row数で、quoted cell内改行を1行と数えない。JSON rows はtop-level input record数とする。encodingは結果JSONでは `UTF8` / `SJIS` のcanonical uppercaseを使い、JSONは `UTF8`。同じ source を複数IMPORT文が参照した場合は同じmetadataなら1 entryへdedupeし、矛盾した通知は内部エラーとしてfail-closedにする。並び順はsource名のUnicode code point順で固定する。

`input_files` は成功だけでなく失敗結果にも常に配列として出す。まだmaterializeされていない unused / skipped / decode失敗中のsourceは載せず、それ以前にmaterialize完了したsourceは残す。絶対 path、mtime、inode、cell値、token、実アプリIDは含めない。

### 3.4 検査 matrix

| ケース | 判定時点 | 期待結果 |
| --- | --- | --- |
| CLI同名重複（CSV/JSON横断含む） | CLI parse後、config前 | Exit 1。後勝ちなし |
| expected同名重複 | CLI parse後 | Exit 1 |
| SQL要求source未供給 | parse後、lock/mutation前 | Exit 1、loader 0、mutation 0 |
| SQL kindとCLI kind不一致 | parse後 | Exit 1 |
| orchestrator hash欠落/余剰 | source集合検査 | Exit 1、`executionStarted=false` |
| expected hash不一致 | preload後、最初のSQL前 | `INPUT_FILE_MUTATED`、Exit 1、mutation 0 |
| supplied source未使用 | 集合検査 | 警告のみ、loader 0、`input_files`非掲載 |
| 非通常 file | lstat / handle stat | stable provider code、mutation 0 |
| open/read不能 | handle open/read | `ImportSourceReadError`、mutation 0 |
| 10 MiB + 1 | engine payload検査 | `ImportSourceTooLargeError`、decode/mutation 0 |
| `maxRecords`超過 | engine materialize | engine stable error、mutation 0 |

IMPORT + `ON ERROR SKIP` + `ON DUPLICATE` は engine既存の事前GETによるcreate/update振分けを使う。重複APIエラーをUPDATEへ変換しない。100件chunk途中でprocessが落ちても、単一の重複禁止キーと同じsource bytesなら再実行で既存keyはupdate、未適用keyはinsertへ収束する。

## 4. engine依存と blocking gap

### 4.1 B177に不足する rows receipt

v3.75.0 の公開 `FlowImportSourcePayload` は `bytes` と任意 `encoding` のみである。`StatementResult.rowCount?` はCREATE TEMP TABLE等の汎用fieldで、IMPORT入力行数を保証しない。安定 `FlowDmlResult` の inserted/updated/deleted countからは、`ON ERROR SKIP`、`VALIDATE ONLY`、CSV subtable継続行、decode途中失敗のsource data row数を復元できない。実装済み内部 `importAudit` も公開契約ではなくrow数を持たない。

engineへ次の最小 additive APIを依頼する。

```ts
interface FlowImportSourceMaterializedInfo {
  readonly name: string;
  readonly kind: "CSV" | "JSON";
  readonly rows: number;
  readonly encoding: ImportEncoding;
}

interface CreateExecutionContextOptions {
  onImportSourceMaterialized?: (
    info: FlowImportSourceMaterializedInfo
  ) => void | Promise<void>;
}
```

通知はRFC 4180/JSON materialize完了後、mutation前、source materialization 1回につき1回とし、callback throwはmutation 0のstatement errorにする。CSV `rows` はheaderを除く物理data record数、JSONはtop-level record数、effective encodingは `SQL > payload > utf8` 後の値とする。source名以外の内容やpathは含めない。engine側testはquoted newline、headerあり/なし、SJIS、JSON、ON ERROR SKIP、maxRecords、callback throw時mutation 0を固定する。

このAPIが v3.75.x patch で公開されるなら最小依存をそのpatchへ上げる。公開API追加をminorとする判断なら v3.76.0以上へ上げる。**v3.75.0だけで非公開 `src/import/*`、内部 `importAudit`、改行countを使ってrowsを埋める案は不採用**とし、receipt公開前は `features.importCsv` を出さず0.8.0をreleaseしない。代替は上流Contractを `rows: null` 許可へ改訂することだが、要求の正を変更するため本計画では選ばない。

### 4.2 公開前のローカル先行手順

1. cleanな `package.json` / `package-lock.json` が3.74.0 registry依存であることを記録する。
2. `npm run dev:engine-local` で隣接 engineを `node_modules` に一時適用する。package/lockは変更しない。`require(.../package.json).version` と `/flow` declaration/value exportを確認する。
3. B177公開APIだけをimportするconsumer smokeとIMPORT contract testを実行する。rows receiptが別commitならそのcommitを含む隣接buildで行う。
4. engineがnpm公開された後、`package.json` を実際にrows receiptを含む最低版へ更新し、`npm install` で lockのversion/resolved/integrityをregistry tarballへ確定する。
5. `npm ci` 後にlocal file linkが残っていないこと、公開tarballのESM/CJS/declarationから必要APIをimportできることを再検証する。
6. README互換表、CHANGELOG、capabilitiesのengineVersionが同じ依存を示すことを確認する。

0.7.0開発時と同様、local engineは開発・先行結合専用で、release artifactやlockへ `file:../kintone-sql-tools` を残さない。

## 5. Execution Result Contract v1.1

`EXECUTION_CONTRACT` は受信側が同じmajor内のadditive propertyを許す既存方針に従い `ksql-flow.execution/v1` のままとする。`formatVersion: 1` とschema `$id` も維持する。文書上のrevisionをContract v1.1と呼ぶ。

```json
{
  "input_files": [
    {
      "name": "sales",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 1234,
      "rows": 10,
      "encoding": "UTF8"
    }
  ]
}
```

schemaは `input_files` をrequiredへ追加せず、propertyとして arrayを定義する。itemは `additionalProperties: false`、5 field必須、name非空、sha256は `^[0-9a-f]{64}$`、bytes/rowsは非負整数、encodingは `UTF8|SJIS` とする。producerは常に配列を出すが、旧v1 fixtureと旧consumerを壊さないためschema requiredにはしない。TypeScriptでは `ExecutionResult.input_files: InputFileReceipt[]` をproducer必須にし、全normalize経路が明示的に `[]` を渡すことで出力漏れを防ぐ。

`INPUT_FILE_MUTATED` を `KNOWN_RESULT_CODES` とschema条件へ純加法で追加し、FAILED / Exit 1 / `executionStarted=false` / CONFIGを固定する。error messageは `IMPORT source "<safe-name>" did not match the expected sha256.` のような固定文にし、期待値・実値の全hash、path、内容を載せない。監査上hashが必要な場合も先頭12桁までとし、Execution Resultの所定 `sha256` field以外へ重複出力しない。

## 6. 変更ファイル一覧

### 6.1 実装・契約

| ファイル | 変更内容 |
| --- | --- |
| `src/cli.ts` | repeatable値の保持、3 flagのallowlist/usage、`name=value`構文、重複・hash集合検査、option変換 |
| `src/jobs.ts` | `loadJobFile`へadditive parse optionsを追加し、IMPORT runで `enableImport:true` |
| `src/importSources.ts`（新規） | source registry、AST要求集合、lstat/open-handle/read/cache/hash、expected照合、receipt収集、provider error安全化 |
| `src/commands/run.ts` | `RunOptions`伝播、standalone/orchestrator preflight、startup failureでもreceipt snapshot、`INPUT_FILE_MUTATED`分類 |
| `src/executor.ts` | `RunJobParams`、IMPORT full validate、`createImportSourceResolver`、同一capabilityのcontext配線、materialized receipt callback、cleanup |
| `src/commands/capabilities.ts` | 全受入完了時だけ `features.importCsv: true` |
| `src/contract/executionResult.ts` | `InputFileReceipt`、`input_files`、normalize context、`INPUT_FILE_MUTATED` |
| `schema/execution-result-v1.schema.json` | additive `input_files`定義とmutated結果条件 |

`src/types.ts` の `JobOutcome` にはfile metadataを混ぜない。Execution Result専用情報はcontract contextで運び、standaloneログや通知への意図しない露出を避ける。

### 6.2 test / fixture

| ファイル | 変更内容 |
| --- | --- |
| `test/__tests__/cli_contract.test.ts` | repeatable、`--flag=value`、Windows path、全重複、empty/relative/hash形式、command allowlist、orchestrator集合 |
| `test/__tests__/import_sources.test.ts`（新規） | lstat/open-handle、同一bytes hash、cache、通常file、10 MiB境界、provider code、cleanup、秘密非出力 |
| `test/__tests__/run.test.ts` | standalone CSV/JSON、UTF-8/SJIS、SQL encoding優先、未供給/未使用、maxRecords、既存run回帰 |
| `test/__tests__/orchestrator_run.test.ts` | SQL前hash照合、欠落/余剰/不一致、failure receipt、stdout純度、executionStarted=false、再実行 |
| `test/__tests__/execution_result_contract.test.ts` | v1.1 schema、旧fixture互換、item厳格性、producer常時配列、mutated組合せ |
| `test/fixtures/import/*`（新規） | ASCIIだけのUTF-8/SJIS/quoted-newline/JSON/10MiB境界/101件upsert用ダミー |
| `test/fixtures/execution-result/*.json` | v1.1成功/失敗例を追加。既存v1 fixtureは後方互換試験用に保持 |
| `test/helpers/mockKintone.ts` | IMPORT実行、mutation call数、chunk途中failure injectionに必要な最小拡張 |
| `test/__tests__/examples.test.ts` | README / specの新CLI例とusageの同期 |

## 7. テスト方針

contract testは責務ごとに分け、単一巨大E2Eだけで合格にしない。

### 7.1 最低ライン

| 観点 | 固定する事実 |
| --- | --- |
| UTF-8 CSV | SQL句なしでUTF-8、quoted newlineを含むRFC 4180 rows、期待書込 |
| SJIS CSV | SQL `ENCODING SJIS`で日本語fixtureをdecodeし、receipt `SJIS` |
| encoding優先 | SQL句がloader metadataより優先。`--import-encoding` は未知flag |
| JSON | repeatable `--import-json` が同じregistry/hash/secret/10MiB制御を通り、UTF8 receipt |
| repeatable | CSV複数、CSV+JSON混在、引数順に関係なくcanonical source名順結果 |
| 未供給 | AST要求名なしでSQL前Exit 1、loader/mutation 0 |
| 重複 | flag内・CSV/JSON横断・programmatic `RunOptions`・engine helperの全層で拒否 |
| sha欠落/余剰/重複 | orchestratorでSQL前Exit 1、stdoutはExecution Resultだけ |
| sha不一致 | loaderと同じbytesで不一致、`INPUT_FILE_MUTATED`、executionStarted=false、mutation 0 |
| 未使用 | 警告、load 0、`input_files`非掲載、成功継続 |
| 非通常file | directory必須。symlinkは作成可能OSで拒否、権限不足Windowsは理由付きskipしCIの1環境で必須 |
| 10 MiB | ちょうど境界はsize理由で拒否しない、+1 byteはdecode/mutation 0 |
| `maxRecords` | `limits.maxReadRows`がengine `maxRecords`へ渡り、超過時mutation 0 |
| failure receipt | source A materialize後にB失敗するとAだけ、未materialize B/unused Cは非掲載 |
| 途中クラッシュ再実行 | 101件以上の単一unique key upsertで1 chunk後にfault、同じshaで再実行し件数・key集合不変、重複0 |

`rows` 試験はLF文字数では通らないfixture（quoted cell内LF、CRLF、末尾改行あり/なし）を使う。途中クラッシュはmock clientの2回目mutationでprocess相当の例外を注入し、1回目の確定chunkを保持した同じworldへ再実行する。再実行はengineがnative upsertではなくIMPORTのread-then-writeを使い、GET後POST/PUTに分かれることもassertする。

### 7.2 fail-closed と秘匿

全失敗testで `postRecords` / `putRecords` / `upsertRecords` / `deleteRecords` の合計が0であることを確認する。engine仕様上metadata GET回数はsource種別で異なり安定契約にしない。出力を連結して次を負のassertにする。

* dummy tokenの完全値
* fixtureにだけ置いたdummy絶対path
* dummy実アプリIDに相当する数値（testでは予約値を使用）
* CSV/JSONにだけ置いた一意のcell値
* stack、cause、OS error詳細

検査対象はstdout、stderr/out、Execution Result、JSONL、通知mock payload、ログアプリmock record。source名自体も安全なfixture名だけを使う。

### 7.3 既存回帰と実行順

1. `npx jest --runInBand test/__tests__/cli_contract.test.ts test/__tests__/import_sources.test.ts test/__tests__/execution_result_contract.test.ts`
2. `npx jest --runInBand test/__tests__/run.test.ts test/__tests__/orchestrator_run.test.ts`
3. `npm run typecheck`
4. `npm run build`
5. `npm test`
6. local engine適用を外し `npm ci`、registry最低版で1〜5を再実行
7. `npm pack --dry-run --json` と隔離directoryへのtarball install後、`capabilities --json`、UTF-8/SJIS/JSON、orchestrator stdout/schema smoke
8. Node 18/20/22とWindows/LinuxでCI。実kintoneは専用検証appとダミーデータだけで、UTF-8/SJIS、101件部分失敗相当、result/ログの秘匿を確認

静的testやmockだけを実機確認済みとは記録しない。実機でprocess killを行う場合は確定chunk、再実行後件数、key重複0、Execution Result sha一致を証跡化する。

### 7.x decodeCsvの実測エッジケース(2026-09-03 engine側実測 — fixture設計の前提)

- LF/CRLF・末尾改行の有無はrows同値。BOMは除去。quoted cell内のLF/CRLFは1 record
- 多列CSVの空行(途中・末尾)は「CSV row N has 1 cells; expected M」でthrow(B178通知なし)
- **1列CSVの末尾空行は空値のdata rowとして+1に数える**(内容が code,A,空行 の3行ファイル → rows=2)。fixtureはこの罠を踏まない構成とし、罠自体もテストで固定する
- headerのみのCSVは「CSV has no data rows」でthrow(通知なし)。NO HEADER COLUMNS(…)は全recordがdata row

## 8. 文書更新

`docs/ksql_flow_spec.md` に既存DML節の注記ではなく独立した「IMPORT」節を追加し、少なくとも次を正本化する。

1. `IMPORT INTO ... FROM CSV <name> [ENCODING UTF8|SJIS] [HEADER句] [BY NAME等]` の正確な句順。JSONとの差、source名とCLI nameの完全一致。
2. `ON DUPLICATE`、`ON ERROR SKIP INTO`、`CHECK WHEN`、`ASSERT`、`VALIDATE ONLY` を含む省略なしの完全例。
3. 素のIMPORT/INSERTは再実行で重複し得ること。推奨は重複禁止設定済みの単一文字列1行または数値keyによるupsertであり、FlowNetの `idempotent:true` はこの形だけを許すこと。
4. 複数値、空cell/NULL、数値、日時、サブテーブル、CSV header/mapping、JSON、10 MiB、`maxRecords`、100件write chunk、ON ERROR SKIPの現在の取込規則。
5. `--import-csv` / `--import-json` / orchestratorのexpected hash、`--import-encoding`が存在しない理由、SQL > loader > UTF-8の優先順位。
6. `input_files` の意味、rows定義、読込済みだけ、失敗時の部分receipt、path/内容非掲載。

完全例のSQLはengine v3.75以降の言語リファレンスとparser testから句順を再確認して転記し、推測で構文を作らない。既存 §3.4 の「IMPORTを伴うupsertはread-then-writeへfallback」と相互参照し、native upsertと矛盾させない。

`README.md` はinstall/CLI usage、3 flag、最小例、互換表を更新する。`CHANGELOG.md` は0.8.0のadditive Contract v1.1、IMPORT既定利用可能面、入力hash/receipt/秘匿、旧run/run-all互換を記載する。`docs/internal/README.md` のlocal engine手順は現行方式で足りるため、実装時に記載差がなければ変更しない。

## 9. リリースと公開順序

0.8.0をminor候補とする。CLI flag、capability、Execution Result additive propertyを同時に公開するため0.7.x patchには載せない。

公開順序は次で固定する。

```text
engine v3.75.0 publish（B177 named source）
  -> rows receiptを含むengine版 publish（§4.1。必要なら3.75.x/3.76.0）
  -> kSQL-Flow dependency/lockをその最低版へ確定
  -> registry tarballでcontract/full/pack/実機 smoke
  -> kSQL-Flow 0.8.0 publish（ここで初めて features.importCsv=true）
  -> FlowNetがkSQL-Flow最低版0.8.0を要求
  -> FlowNetのinputs schema/capability gateを開放
```

もしengine側がv3.75.0公開前にrows receiptを同じreleaseへ含められるなら、依存は `^3.75.0` とする。v3.75.0が先に固定公開された場合は、実際にreceiptを含む最初の版を最低依存にする。背景上の「engine v3.75.0への依存」を満たすためversion文字列だけを先に固定し、欠けたrowsを私的APIで補うことはしない。

release gateは次の全項目である。

* registry packageから必要な型/value/receiptをimportできる
* CSV UTF-8/SJIS、JSON、sha preflight、Execution Result、stdout純度がgreen
* `features.importCsv: true` のbuildで上記全機能が実際に利用可能
* package/lock/README互換表/CHANGELOG/versionが一致し、local file dependencyなし
* tarballにsrc/test/docs/internal、fixture、絶対path、秘密が混入しない
* FlowNet側が0.8.0未満またはcapabilityなしをNetwork lock前に拒否する

rollbackはFlowNetがinputs開放を止め、kSQL-Flow 0.7.0へ戻す。engineの追加はopt-inかつadditiveなのでengine downgradeを必須にしない。

## 10. 見積り

1人日を実装、自動test、自己review修正までとし、npm公開承認待ち、実機環境待ち、FlowNet側実装は含めない。

| 作業 | 見積り |
| --- | ---: |
| engine rows receiptの契約確定・local consumer smoke | 0.4〜0.7人日 |
| repeatable CLI parser、集合検査、`jobs.ts` parse配線 | 0.6〜0.9人日 |
| open-handle loader、hash/cache/provider error、cleanup | 1.0〜1.4人日 |
| full validate/context配線、receipt、Execution Result/schema | 0.9〜1.3人日 |
| contract/unit/integration/fault-injection testとfixture | 1.5〜2.1人日 |
| spec/README/CHANGELOG/互換表 | 0.6〜0.9人日 |
| registry/pack/複数Node・OS確認、review修正 | 0.6〜0.9人日 |
| **kSQL-Flow側合計** | **5.6〜8.2人日** |

上流仮置き4〜7人日より0.6〜1.2人日程度上振れし得る。実コード調査で、(1) 現行parserがrepeatable値を保持しない、(2) `loadJobFile`がexecutorより前にIMPORTをKSQL1202にする、(3) run本実行に明示full validationがない、(4) failureでもreceiptを保持するExecution Result lifecycle、(5) RFC 4180 rowsの公開API gap、が追加作業として判明したためである。上限8.2人日はWindows/Linux file test、101件部分失敗、review修正を含む。FlowNetとの実機E2Eを別に行う場合は0.5〜1.0人日を別枠とする。

engine側rows receiptの実装・release作業はengine担当の別見積り（目安0.5〜1.0人日）であり、上表にはconsumer側の契約確認だけを含む。

## 11. 実装順と完了条件

### 11.1 実装順

1. engine rows receiptの契約を確定し、隣接buildの公開 `/flow` だけでconsumer smokeを通す。
2. repeatable parserとsource集合の純粋関数を実装し、CLI contract testを先にgreenにする。
3. open-handle loader/hash/cacheとfailure分類を実装し、file/secret testをgreenにする。
4. `jobs.ts`、`run.ts`、`executor.ts`へ同じcapability/resolverを配線する。orchestrator sha failureが `executionStarted=false` になるtestを先に置く。
5. Execution Result type/schema/fixture/normalizerを更新し、旧v1 fixture互換とfailure partial receiptを固定する。
6. IMPORT実行、maxRecords、10 MiB、途中クラッシュ再実行を通す。
7. 文書とrelease metadataを更新し、全回帰、registry、pack、実機の順に検証する。
8. 最後にだけ `features.importCsv: true` を追加し、そのcommitでもcapabilities/contract/full suiteを再実行する。

### 11.2 完了条件

1. `run` がCSV/JSONの複数named sourceを欠落なく受け、engine公開resolverでだけ実行する。
2. orchestratorの使用sourceは同一bytesのsha照合後にだけ最初のSQL文へ進む。不一致はmutation 0、`executionStarted=false`。
3. duplicate、未供給、hash欠落/余剰/重複/不一致は実行前エラー、未使用は警告である。
4. `input_files` がsource名、sha256、bytes、engine確定rows/effective encodingだけを持ち、成功/失敗双方で取得済み範囲を返す。
5. token、実アプリID、絶対path、cell値が全出力面にない。
6. UTF-8/SJIS/JSON/10MiB/maxRecords/非通常file/途中クラッシュ再実行のcontract testと既存全suiteがgreen。
7. `--import-encoding` は存在せず、SQL encoding優先規則がtestと仕様で一致する。
8. registry依存、lock、tarball、互換表がrows receiptを含むengine最低版と一致する。
9. 上記完了後のbuildだけが `features.importCsv: true` を返す。
10. kSQL-Flow 0.8.0公開後にFlowNetが最低版/capabilityを固定してからinputsを開放する。

