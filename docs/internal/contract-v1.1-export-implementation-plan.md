# kSQL-Flow Contract v1.1（EXPORT sink 配線）実装計画

* 作成: 2026-09-04（Codex）
* 対象: `@rex0220/ksql-flow` 0.8.0 から 0.9.0（予定）
* 要求の正: `../ksql-flownet/docs/internal/csv-io-implementation-plan.md` §4.2〜§4.3
* engine 契約: `../kintone-sql-tools` の `docs/b179-csv-export-spec` (`ee404f1`) にある `docs/internal/ksql_b179_csv_export_sink_spec_r2.md`、対象版 v3.77.0
* 調査時点: kSQL-Flow `main` `03d0341`（`origin/main` と一致）。既存の未追跡 `.claude/` は本計画の対象外
* 状態: **実装方針は確定可能。ただし engine B179 は R2 仕様のみで、公開 `/flow` API を同梱する v3.77.0 の実装・公開が release gate**

---

## 0. 結論

Contract v1.1 export は、現行の単一 `run` 経路へ CSV artifact sink を純加法で接続する。CLI は repeatable な `--export-csv` と全 sink 共通の `--export-encoding` / `--export-timezone` を受け、名前付き形式は engine の `createExecutionContext({ exportSinks })`、単文 SELECT の名前なし形式は `serializeSelectResultAsCsv` へ接続する。CSV の値変換、列 metadata、RFC 4180、timezone、UTF-8/SJIS receipt は engine の公開 API を唯一の正とし、kSQL-Flow 内へ serializer を再実装しない。

文ループ完了後、名前付き sink は `exportSinkStatus` を必ず確認する。`"materialized"` だけを context dispose 前に serializeし、`"not-created"` は成果物集合から除外する。全 materialized sink の serialize が成功してから filesystem 操作を始め、各 payload は同一 directory の一時 fileへ全量 write、fsync、close、renameする。rename の `EPERM` 等では旧 fileを削除せず、一時 fileを削除してジョブを error にする。複数 target の保証は各 file単位であり、複数 rename を一つの transactionにはしない。

Shift_JIS は engine CLI と同じ `encoding-japanese@2`（MIT）を使う。library は表現不能文字を `?` 等へ黙って置換するため、`encode -> TextDecoder("shift_jis") -> canonical textとの完全一致` を wrapper が検査し、不一致なら bytes を捨てて throwする。kSQL-Flow の通常 npm CLI は非bundleの `dist` を実行するため、これは devDependency ではなく production `dependencies` に置く。Windows SEA版には esbuild で内包し、追加サイズを実測する。

orchestrator mode の Execution Result には additive な `output_files` を常に配列で出し、完成 pathへの rename が成功した artifactだけ `{name, sha256, bytes, rows, encoding}` を載せる。sha256 は engine が返した `result.data` から一度だけ計算し、atomic writerにも同じ `Uint8Array` を渡す。path、CSV text、cell値は結果へ含めない。全経路と配布形態が成立した 0.9.0 buildでのみ `features.resultCsv: true` を公開する。

ユーザー要求中の `--export-timezout` は、確定済み R2 契約の `--export-timezone` の誤記として扱う。0.9.0 は `run` だけを対象とし、`run-all` へ暗黙拡張しない。

## 1. 現状調査（実コード、2026-09-04）

### 1.1 `run` の option 伝播と import 実装済み構造

現行の伝播は次のとおりである。

```text
src/cli.ts
  parseArgs
    scalar -> flags: Map<string, string | boolean>
    IMPORT repeatable -> repeatedFlags: Map<string, string[]>
  validateArgs（command別allowlist、orchestrator all-or-none、IMPORT構文）
  runOptionsFromArgs
    -> RunOptions
      -> runCommand
        -> standalone / orchestrator分岐
          -> loadJobFile(..., {enableImport:true})
          -> ImportSourceRegistry
          -> runJob(RunJobParams)
```

* `src/cli.ts:18-53,99-135`: repeatable値を保持する基盤は importで実装済みだが、対象は3つのIMPORT flagだけである。`--export-csv` を同じ専用集合へ追加し、既存scalar flagの後勝ち挙動は変えない。
* `src/cli.ts:55-70`: `run` はcommand別allowlistを持ち、export flagは未登録である。`run-all` はIMPORTも受けない現行境界であり、0.9.0でもexportを追加しない。
* `src/cli.ts:181-201,493-523`: IMPORTはCLI構文をconfig/APIより前に検査し、型付き入力として `RunOptions` へ渡す。EXPORTも `parseExportOutputs` の純粋関数を同じ位置で呼び、構文、重複、option値を先行検査する。
* `src/commands/run.ts:33-59`: `RunOptions` / `OrchestratorRunOptions` はIMPORTだけを保持する。export定義と共通serialize optionをadditiveに追加する。
* `src/commands/run.ts:83-198,294-393`: standaloneとorchestratorは別の外側制御を持つが、最終的に同じ `runJob` を呼ぶ。両経路で同じ export registryを生成し、executorへ渡す。

IMPORTのopen-handle loaderは入力bytes、hash、materialize receiptの責務に特化している。EXPORTは逆向きであり、`src/importSources.ts` に混在させない。新規 `src/exportSinks.ts` にCLI表現、engine sink宣言、serialize済みpayload、output receiptを閉じ込め、filesystem責務は `src/exportFiles.ts` に分ける。

### 1.2 executor、文ループ、EXIT

* `src/executor.ts:103-160`: parse errorとIMPORT full validation/preloadはログアプリのJOB record作成より前に処理される。
* `src/executor.ts:162-258`: JOB record、分散lock、JSONL、write chunk callbackを準備する。
* `src/executor.ts:266-285`: `createExecutionContext` は現在この後に生成され、IMPORT resolverとreceipt callbackを渡す。ここへ `exportSinks` 宣言を加える。
* `src/executor.ts:294-377`: 全statementを順番に `executeStatement` する。正常な `EXIT_NO_DATA` 後もloopは継続し、engineの `skippedReason:"exit"` を回収できる。assert/error/cancel/timeoutは成果物処理へ進めない。
* `src/executor.ts:395-430`: status確定後すぐcontextをdisposeしており、現状のままではdispose前必須の `exportSinkStatus` / `serializeExportSink` を呼べない。
* `src/executor.ts:432-476`: dispose後にJOB終了recordとJSONLを確定する。export file書込を `runCommand` 復帰後に行うと、書込失敗なのにJOBが成功済みになるため不可である。

実装では次の順序へ変更する。

```text
CLI / SQL export preflight
  -> createExecutionContext({..., exportSinks})（engineの同期sink検査）
  -> JOB lock / EXECUTION_STARTED
  -> 全statementを処理（EXIT後skipを含む）
  -> 成功/NO_DATA時だけ全sink status確認
  -> materialized全件をcontext dispose前にメモリserialize
  -> context dispose
  -> serialize全件成功時だけ一時file作成・atomic replace
  -> JOB終了record / JSONL / JobOutcome
  -> orchestrator Execution Result
```

engineのsink不存在、宣言重複、DROP済み等をSQL/API実行前に保証するため、export指定時はactual managed contextの生成をJOB分散lock取得より前へ移す。既存のchunk callbackやIMPORT resolverは同じcontext optionへ保持し、早期return・lock失敗を含む全経路でcontextをdisposeする。EXPORTなし経路のobservableなstatement結果、metrics、API回数、exit codeは回帰testで固定する。

### 1.3 Execution Result の組立て

* `src/commands/run.ts:294-493`: orchestrator経路だけがExecution Resultを生成する。`ImportSourceRegistry` はtryの外で生存し、最後に `snapshotInputFiles()` をnormalizerへ渡す。
* `src/contract/executionResult.ts:67-98,157-210`: `ExecutionResult` はproducer型として `input_files` を常時出す。export receipt用のcontext fieldはまだない。
* `schema/execution-result-v1.schema.json:7-69`: rootは `additionalProperties:true` でv1 additive propertyを許す。`input_files` と同型に `output_files` をpropertyとして追加できる。
* `src/contract/executionResultWriter.ts:17-67`: Execution Result fileは同一directory temp + fsync + renameだが、既存targetを拒否する契約である。CSV exportは既存targetの全量置換が必要なので、このwriterを流用しない。

`ExportSinkRegistry` は `runJob` より長く保持し、rename成功時にだけreceiptを確定する。orchestratorのnormalizerへ `snapshotOutputFiles()` を渡す。startup failure、sink未生成、serialize前失敗は `[]`、複数renameの途中失敗はrename済みartifactだけを返す。

### 1.4 capabilities、version、配布

* `src/commands/capabilities.ts:7-31`: 通信なしの固定features objectで、現在 `importCsv:true` まで公開済み。全gate通過時だけ `resultCsv:true` を追加する。
* `package.json` / lockは kSQL-Flow 0.8.0、engine `^3.76.0`。engine B179の対象版はv3.77.0だが、調査対象branch `ee404f1` は仕様commitだけで実装を含まない。
* npm packageは `tsc` 生成の `dist` と依存packageを配布する。`scripts/build-win-binary.mjs` だけが `dist/cli.js` と依存をesbuildで単一bundle化し、SEAへ注入する。
* engine R2の比較実測では `encoding-japanese@2` のminified Node CJS bundle増分は約231 KB、MITで、`iconv-lite@0.6` の494 KBより小さい。ただしkSQL-Flowの非minify SEA設定での増分は別にbaseline/afterを測る。

## 2. CLI契約と実行前検査

### 2.1 optionとrepeatable値

追加するoptionは次のとおりである。

```text
--export-csv <name>=<path>  temp table #<name>をCSVへ出力（repeatable）
--export-csv <path>         単文SELECT結果をCSVへ出力
--export-encoding <type>    utf8 | sjis（既定utf8）
--export-timezone <zone>    DATETIMEセル変換用IANA timezone
```

`--export-csv` だけを `REPEATABLE_VALUE_FLAGS` へ追加する。encoding/timezoneはscalarであり、既存どおり複数指定時は後勝ちとなる。`--flag value` と `--flag=value` の両表現を維持する。export optionは `run` のみで受理し、`run-all`、validate、dry-runではunknown/inapplicableまたは明示競合としてExit 1にする。dry-runはartifactを作らない既存意味を守るため、exportとの併用をconfig/API/file操作前に拒否する。

### 2.2 `name=path` 判別

`parseExportOutputs` は次を固定する。

1. `=` がなければ全体を名前なしpathとする。
2. `=` があれば最初の1個だけで分割し、2個目以降はpathに保持する。
3. `=` を含む指定は常に名前付きであり、無効な左辺を名前なしpathへfallbackしない。
4. 左辺は空、先頭`#`、control文字を拒否する。kSQL temp table識別子としての最終判定はengineのcontext作成へ委ねる。
5. 右辺/名前なしpathの空文字、NUL、CSV stdoutを意味し得る `-` を拒否する。
6. Windows drive letterの `:` は区切りではない。`C:\out\a.csv` は名前なしpath、`export=C:\out\a=b.csv` は名前付きpathとして保持する。

名前付きと名前なしは混在不可、名前なしは1件だけとする。名前なしはASTがちょうど1文のSELECTである場合だけ許し、DML、EXPLAIN、複文、「最後のSELECT」推測は実行前Exit 1とする。名前なしartifactの内部logical nameは予約値 `select` とし、standalone診断でのみ用いる。orchestratorから単文SELECTを呼ぶ場合も `output_files[].name` を一意にするため同じ `select` を返す。

### 2.3 sink名、path、未使用指定

検査順序は次のとおりとする。

| 検査 | 判定 | 失敗時 |
| --- | --- | --- |
| encoding | `utf8` / `sjis` の小文字だけ | Exit 1、config/API/file操作前 |
| timezone | 空/NUL拒否。IANA zone妥当性をNode `Intl`で先行確認し、engine serializerでも再確認 | Exit 1 |
| sink名重複 | case-sensitive完全一致。後勝ちにしない | Exit 1 |
| target重複 | `path.resolve(process.cwd(), receivedPath)` 後、Windowsではfilesystem比較に合わせcase-insensitive、POSIXではcase-sensitive | Exit 1 |
| result path衝突 | `--result-json` が `-` 以外ならresolve済みexport targetとの一致を拒否 | Exit 1 |
| 名前なしtarget | 単文SELECTだけ | Exit 1、engine API 0 |
| named target | engine `createExecutionContext({exportSinks})` で宣言名、CREATE不存在/重複、DROP済みを同期検査 | Exit 1、statement/API 0 |

kSQL-Flow CLIは相対pathも受理し、process cwd基準で解決して受けたpathへ書く。FlowNetの `<KSQL_FLOWNET_IO_DIR>/out` allowlist、絶対path、symlink/junction/traversal防御はFlowNet側責務であり、kSQL-Flowがそのpolicyを再実装しない。ただし同一target判定とatomic writerのため内部ではabsolute pathへ解決する。そのabsolute pathをExecution Result、JSONL、通知、error messageへ含めない。

指定されたnamed `--export-csv` は全てengineへ `exportSinks` として宣言するため、「SQLに対応CREATEがない未使用指定」は警告ではなく実行前errorである。逆にSQL内の未指定temp tableは通常の一時表でありerrorにしない。実体化されなかった宣言sinkは未使用ではなく§3.2の `"not-created"` として扱う。

## 3. flow配線とartifact lifecycle

### 3.1 型とregistry

新規 `src/exportSinks.ts` に次のprocess内型を置く。

```ts
type ExportEncoding = "utf8" | "sjis";

interface ExportSinkInput {
  readonly name: string;              // named sink、または単文予約値select
  readonly sinkName?: string;         // named時だけ。engineへ渡すname
  readonly targetPath: string;        // process内限定。出力・ログへ渡さない
}

interface SerializedExportArtifact {
  readonly input: ExportSinkInput;
  readonly data: Uint8Array;           // engine戻り値と同一object
  readonly receipt: FlowCsvExportReceipt;
  readonly sha256: string;             // dataから算出
}

interface OutputFileReceipt {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly encoding: "utf8" | "sjis";
}
```

`RunOptions.exportSinks` から `RunJobParams.exportSinks` へregistryを渡す。registryは以下を提供する。

* `flowDeclarations()` — named入力だけを `{name}` 配列にしてcontextへ渡す。
* `serialize(context, singleSelectResult?)` — status確認と全materialized payloadのメモリ確定。file操作なし。
* `commit()` — 全serialize成功後にatomic writerを呼び、rename成功ごとにreceipt確定。
* `snapshotOutputFiles()` — pathを含まない確定済みreceiptのcopyをsink指定順で返す。

sha256は `crypto.createHash("sha256").update(data).digest("hex")` で `data` 自体から求める。writerへはcopy、再encode、`text` ではなく同じ `data` を渡し、`receipt.bytes === data.byteLength === 実write byte数` をassertする。

### 3.2 §8.3手順とEXIT交差

文ループ後、statusがSUCCESSまたはNO_DATAである場合だけ次を実行する。

```text
named sinkごとに exportSinkStatus(context, name)
  materialized -> serializeExportSink(context, name, options)
  not-created  -> skip（fileもreceiptも作らない）
  failed       -> 成果物処理せずjob failure
  incomplete   -> 成果物処理せずjob failure

single SELECT
  -> 唯一のStatementResultをserializeSelectResultAsCsv(result, options)
```

全statementを処理するまではstatus確認もしない。named sinkが一つでも `failed` / `incomplete` ならserializerとfile writerを呼ばない。`materialized` sinkは全件serializeし終えるまで一時fileも作らない。1件でもheader、unsupported column、値、timezone、encoderで失敗したら全payloadを破棄し、全targetを不変にする。

`not-created` は正常なEXIT交差である。該当targetを新規作成/切詰め/削除せず、既存fileを維持し、`output_files` に載せない。既存のNO_DATA status/Exit 0、通知抑止を変更しない。他のsinkがEXIT前にmaterialize済みなら、そのsinkだけをserialize/write/receipt化する。

### 3.3 executorへの挿入点と失敗分類

`runJob` の内部を次の3段に分ける。

1. context作成と実行前検査。export宣言のengine errorは最初のSQL文前、`executionStarted=false`、Exit 1 / `VALIDATION_ERROR`。
2. 文実行とserialize。engineの `ExportSink*` errorはSQL開始後の決定的artifact失敗としてExit 1 / `SQL_ERROR` とし、engineのstable `error.code` をExecution Resultへ保持する。
3. dispose後のfile commit。write/fsync/close/rename等のOS errorはExit 3 / `INTERNAL_ERROR` とし、cell値、absolute path、stack/causeを公開出力へ出さない。

export commitはJOB終了record、JSONL `job_finish`、通知、`printOutcome` より前に完了させる。失敗時は `onExecutionError` に原因/codeを渡し、ログアプリJOBもFAILEDに更新する。standaloneとorchestratorは同じ成否を返し、orchestratorだけがreceiptをExecution Resultへ転記する。

### 3.4 atomic writer

CSV専用writerは既存Execution Result writerと別moduleにし、次を固定する。

```text
全artifact serialize/hash/receipt検査
  -> targetと同一directoryに一時fileをexclusive create (wx, mode 0600)
  -> Uint8Arrayをshort write考慮で全量write
  -> fsync
  -> close
  -> rename(temp, target)
  -> 成功receipt確定
```

複数sinkでは全serialize後、各sinkを順番にcommitする。write/fsync/close失敗時はそのtempを削除し、renameしない。renameが `EPERM`、`EACCES`、競合等で失敗した場合もtempを削除し、旧targetを維持し、旧file削除後renameへのfallbackをしない。cleanup errorは主要errorを上書きしない。新規targetでは完成fileだけ、既存targetでは旧全体または新全体だけが観測される。

複数target横断のtransactionは保証しない。後続sinkのrename失敗時、先にrename済みのartifactはrollbackせず `output_files` へ載せ、未rename分は載せない。hard kill / power lossはJavaScriptのfinallyを実行できないため、即時のtemp 0件を保証できない。contract testの「途中クラッシュ」はwrite/fsync/close/rename各点の注入例外またはcooperative cancellationとして行い、catch/finally後にtemp 0件を検証する。OS強制終了でstaged fileが残り得る事実はengine R2 §7.5どおり文書化し、別processのtempを無条件削除する危険なstartup cleanupは0.9.0へ入れない。

## 4. Shift_JIS encoder wrapper

`src/exportSinks.ts` から分離した `src/shiftJisEncoder.ts` に `FlowExportTextEncoder` 実装を置く。

```text
canonical Unicode text
  -> encoding-japanese@2 でCP932 bytesへencode
  -> Uint8Arrayへ確定
  -> new TextDecoder("shift_jis", {fatal:true}).decode(bytes)
  -> canonical textとUTF-16 code-unit完全一致
  -> 一致時だけbytesを返す
```

不一致時は最初の不一致位置をcode point単位で求め、`U+XXXX` だけをdiagnosticへ含めてthrowする。cell全文、record全文、前後文字列は含めない。wrapper自体は `encoding:"sjis"` を公開し、library戻り値が配列でない、byte範囲外、decode失敗もthrowする。engineの `serialize*` がこれを `ExportSinkEncodingError` に正規化する。

必須fixtureは次のとおりである。

* 成功: ASCII、日本語、半角カナ、①、Ⅰ、髙、﨑、U+FF5E。engine CLIの同fixtureとbyte-for-byte一致する。
* fail-closed: U+301C、U+00A5、U+2212、U+2014、emoji、Hangul。`?` や別文字を含む完成fileを残さない。
* encode後decodeが「もっともらしい別文字」になるU+2212も完全一致で拒否する。

`encoding-japanese@2` は `package.json.dependencies` / lockへ追加する。licenseはMITだが、package tarballとWindows ZIPのthird-party notice方針を確認する。サイズは (a) `node_modules/encoding-japanese` のinstalled size、(b) SEA用esbuild output、(c) exe、(d) ZIPを追加前後で測定し、engine側231 KBというminified値をkSQL-Flow実測値として流用しない。`--export-encoding utf8` でも通常npm installには依存が入る点をrelease noteへ明記する。

## 5. Execution Result Contract v1.1

`EXECUTION_CONTRACT`、`formatVersion:1`、schema `$id` は維持する。v1のadditive propertyとして次を追加する。

```json
{
  "output_files": [
    {
      "name": "export",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 1234,
      "rows": 100,
      "encoding": "utf8"
    }
  ]
}
```

TypeScript producer型では `ExecutionResult.output_files: OutputFileReceipt[]` を必須にし、`NormalizeExecutionResultContext.outputFiles` も全呼出箇所で明示する。schemaでは旧v1 fixture/consumer互換のためroot `required` へ追加せず、propertyとしてarrayを定義する。itemは `additionalProperties:false`、5 field必須、name非空、sha256 `^[0-9a-f]{64}$`、bytes/rows非負整数、encoding `utf8|sjis` とする。

producerはexport指定の有無、成功/失敗にかかわらずorchestrator結果へ常に配列を出す。`output_files` にはrename済み完成artifactだけを載せる。`not-created`、serialize済みだが未rename、tempだけ作成済み、失敗したtargetは載せない。絶対/相対path、mtime、temp名、CSV text、cell値、sha256以外の識別情報を含めない。指定順を保持し、同じas-of/context/input bytes/optionsで再実行した場合はname、sha256、bytes、rows、encodingが一致することをcontract testで固定する。

## 6. capability、engine依存、release gate

`features.resultCsv:true` は次を全て満たす0.9.0 buildでのみ追加する。途中実装ではfalseを返すのではなくproperty自体を追加しない。

1. engineのregistry packageから `serializeCsvExport`、`serializeSelectResultAsCsv`、`serializeExportSink`、`exportSinkStatus`、関連型をESM/CJS/declarationでimportできる。
2. `createExecutionContext({exportSinks})` がR2の同期検査と4 statusを実装する。
3. UTF-8/SJIS、named/単文、EXIT、atomic replace、Execution Result、stdout純度が通常npm CLIとWindows SEA版で成立する。
4. package/lock/README/spec/CHANGELOG/capabilitiesのengine最低版が一致する。

engine最低依存はB179同梱予定の `^3.77.0` とする。ただし、v3.77.0公開前にversion文字列だけを先上げしない。実装済み隣接branchを `npm run dev:engine-local` で先行結合し、公開後にregistry tarballへ切り替えてlockのversion/resolved/integrityを確定する。非公開 `src/export/*`、engine CLI内部関数、共有 `ExecuteOptions`、型castによるoption注入は使わない。

公開順序は次で固定する。

```text
engine B179実装・review・v3.77.0 publish
  -> kSQL-Flow dependency/lockを^3.77.0へ確定
  -> local/registry contract・pack・SEA smoke
  -> kSQL-Flow 0.9.0 publish（features.resultCsv:true）
  -> FlowNetが0.9.0 + resultCsvを最低条件にoutputsを開放
```

FlowNetはNetwork lock取得前に `resultCsv:true` を要求し、古いkSQL-Flowではoutputs付きnetworkを拒否する。kSQL-Flow 0.9.0単独ではstandalone exportを利用できる。

## 7. 変更ファイル一覧

### 7.1 実装・契約・依存

| ファイル | 変更内容 |
| --- | --- |
| `src/cli.ts` | 3 optionのallowlist/usage、`--export-csv` repeatable保持、最初の`=`規則、dry-run/run-all競合、option変換 |
| `src/exportSinks.ts`（新規） | CLI入力型、重複/path衝突、engine宣言、status/serialize、sha256、receipt lifecycle |
| `src/exportFiles.ts`（新規） | 同一directory temp、全量write、fsync/close、atomic replace、EPERM/cleanup |
| `src/shiftJisEncoder.ts`（新規） | `encoding-japanese@2` CP932 encode、TextDecoder round-trip完全一致、fail-closed diagnostic |
| `src/commands/run.ts` | `RunOptions`伝播、standalone/orchestrator registry lifecycle、result path衝突、output receipt snapshot |
| `src/executor.ts` | `RunJobParams`、`exportSinks` context option、単文result保持、§8.3 status/serialize、dispose後commit、失敗分類 |
| `src/commands/capabilities.ts` | 全release gate通過時だけ `features.resultCsv:true` |
| `src/contract/executionResult.ts` | `OutputFileReceipt`、`output_files`、normalize contextと全生成経路 |
| `schema/execution-result-v1.schema.json` | additive `output_files` item定義 |
| `package.json` / `package-lock.json` | version 0.9.0、engine `^3.77.0`、`encoding-japanese@2` production dependency |
| `scripts/build-win-binary.mjs` | SJIS exportを含むSEA smoke、bundle/exe/ZIPサイズ記録（必要な最小変更） |

`src/types.ts` の `JobOutcome` にpathやbytesを混ぜない。artifact状態はexport registry、Execution Result専用metadataはnormalizer contextで運び、通知や既存ログへpath/内容が漏れるのを防ぐ。

### 7.2 test / fixture

| ファイル | 変更内容 |
| --- | --- |
| `test/__tests__/cli_contract.test.ts` | repeatable、最初の`=`、Windows path、無効左辺、name/path重複、named/unnamed混在、encoding/timezone、command競合 |
| `test/__tests__/export_sinks.test.ts`（新規） | registry、status 4値、serialize全件先行、sha/data同一性、atomic writer、partial multi-target receipt、秘密非出力 |
| `test/__tests__/shift_jis_encoder.test.ts`（新規） | CP932成功bytes、engine CLI golden、U+301C等のround-trip不一致throw |
| `test/__tests__/run.test.ts` | standalone named/単文、値変換golden、EXIT交差、既存run/import混在、未使用指定、失敗分類 |
| `test/__tests__/orchestrator_run.test.ts` | `output_files`、stdout純度、result path衝突、not-created、rename失敗、既存file維持、入力+出力同時使用 |
| `test/__tests__/execution_result_contract.test.ts` | v1.1 schema、旧fixture互換、producer常時配列、item厳格性、path非掲載 |
| `test/__tests__/inspection_commands.test.ts` | 最終buildの `features.resultCsv:true` |
| `test/__tests__/examples.test.ts` | help/README/specのflag・例・互換表同期 |
| `test/fixtures/export/*`（新規） | §2.4 scalar/複数値/user/空/数値/日時/unsupported/quoted/encoding golden |
| `test/fixtures/execution-result/*.json` | outputあり成功、not-created、partial commit失敗を追加。旧v1 fixtureは維持 |

## 8. contract test方針

### 8.1 engine値変換golden（R2 §2.4準拠）

公開 `/flow` APIを通し、named sink、単文SELECT、`serializeCsvExport`の同一入力が同じcanonical bytesになることを固定する。

| 観点 | 固定する期待値 |
| --- | --- |
| header | 正式field code/result列名、順序保持、case-sensitive重複拒否 |
| scalar/空 | string保持、null/undefined/空文字/欠落は空cell、非文字列拒否 |
| 複数値 | checkbox/multi/categoryは要素をLF連結、`[]`は空、RFC 4180 quote |
| 主体選択 | USER/ORG/GROUP/STATUS_ASSIGNEEは`code`だけLF連結、name非出力 |
| unknown type | JSON風stringをparseせず生値保持 |
| NUMBER/CALC | 非指数は生値、指数は丸めなし10進展開、1,024文字超拒否 |
| DATE/DATETIME | DATE不変、既定UTC保持、明示timezoneのみoffset変換、ミリ秒保持 |
| unsupported | SUBTABLE/FILEをserialize前に拒否。`APP$明細`利用案内 |
| CSV | header必須、CRLF、最終CRLF、BOMなし、quote/double quote |
| receipt | rows/columns/data.byteLength/encodingがgolden一致 |

### 8.2 fail-closed、EXIT、atomic write

最低限、次を独立testにする。

* sink名の無効/重複、対応CREATE不存在/重複、DROP済み、名前なし複文/DMLはSQL/API/fileより前に失敗する。
* `materialized`だけserializeする。sink作成前EXITはnot-created、file非掲載、既存file不変、NO_DATA/Exit 0維持。作成後EXITは該当fileを生成する。
* `failed` / `incomplete` はserializer 0回、完成file変更0、一時file 0。
* 複数sinkの後段でserializer errorを起こし、先行sinkを含む全targetが不変である。
* SJISのU+301C、U+00A5、U+2212、U+2014、emoji、Hangulでthrowし、完成fileなし/旧file不変、一時file 0。
* write、short write、fsync、close、rename `EPERM` をinjectし、旧file維持、temp cleanup、non-zeroを確認する。
* 複数renameの2件目失敗は1件目だけ完成/receipt、2件目旧file維持、全temp cleanupになる。
* process相当の途中例外とcooperative cancellationを各stageへ注入し、finally後にtemp 0を確認する。hard kill直後のtemp 0は保証対象としない。
* `--result-json -` + exportでstdoutはExecution Result JSON object 1個+LFだけ、CSV bytes/receipt診断/進捗はstdoutへ出ない。
* `--export-csv`なし、IMPORTのみ、IMPORT+EXPORT、既存run/dry-runの全回帰でstdout、status、metrics、API回数が不変である。

### 8.3 実行順と配布検証

1. `npx jest --runInBand test/__tests__/cli_contract.test.ts test/__tests__/shift_jis_encoder.test.ts test/__tests__/export_sinks.test.ts test/__tests__/execution_result_contract.test.ts`
2. `npx jest --runInBand test/__tests__/run.test.ts test/__tests__/orchestrator_run.test.ts`
3. `npm run typecheck`
4. `npm run build`
5. `npm test`
6. local engine適用を外し、`npm ci` 後にregistry v3.77.0で1〜5を再実行
7. `npm pack --dry-run --json`、隔離directoryへtarball installし、capabilities、named/単文UTF-8/SJIS、orchestrator stdout/schemaをsmoke
8. `npm run build:win-binary` でSJISを含むSEA smoke、追加前後のbundle/exe/ZIP byte数を記録
9. Node 18/20/22、Windows/Linuxでatomic replace/platform test。実kintone専用検証appで複数値、日時、EXIT、同一as-of再実行sha一致を確認

mock/fixture/静的testだけを実機確認済みと記録しない。実機証跡はengine版、kSQL-Flow版、OS/Node、SQL、sink status、exit code、sha256/bytes/rows/encoding、旧file維持、一時file一覧を残し、token、実アプリID、cell値は公開文書へ載せない。

## 9. 文書更新

`docs/ksql_flow_spec.md` は既存 §3.9 IMPORTの直後に独立した「CSV EXPORT sink — Contract v1.1」節（番号は実装時に採番）を追加する。少なくとも次を正本化する。

1. named temp tableと単文SELECT、`--export-csv` 2形式、最初の`=`、複文名前なし禁止、「最後のSELECT」を選ばないこと。
2. engine R2 §2.4の値変換、RFC 4180、BOMなし、全件メモリ、SUBTABLE/FILE非対応。
3. `--export-encoding` / `--export-timezone`、SJIS round-trip fail-closed。
4. status 4値とEXIT交差。not-createdはfile/receiptなし、既存file/NO_DATA維持。
5. atomic replace、Windows `EPERM`、各file単位保証、hard kill時staged tempの限界。
6. `output_files` の意味、rename済みだけ、sha256/data同一性、path/内容非掲載。
7. path allowlist/絶対path要求はFlowNet責務で、standalone CLIは相対pathもcwd基準で受理すること。

`README.md` はCLI usage、UTF-8/SJIS例、named/単文例、Execution Result/capability、engine互換表を0.9.0 / ^3.77.0へ更新する。`CHANGELOG.md` は0.9.0にadditive Contract v1.1 export、atomic replace、SJIS dependency/size、既存run/import互換を記載する。`docs/internal/README.md` はlocal engine手順の最低版を更新する。CLI helpは文書と同じoption名・制約にする。

## 10. 見積り

1人日を実装、自動test、自己review修正までとし、engine実装/publish待ち、実機環境待ち、FlowNet側実装は含めない。

| 作業 | 見積り |
| --- | ---: |
| engine v3.77.0公開API確認、local/registry consumer smoke | 0.3〜0.5人日 |
| repeatable CLI、name/path/mode/衝突preflight | 0.5〜0.8人日 |
| export registry、context/status/単文SELECT配線、executor lifecycle組替え | 1.0〜1.4人日 |
| CP932 wrapper、dependency、round-trip/byte golden、size測定 | 0.5〜0.8人日 |
| atomic replace、EPERM/short write/複数target fault injection | 0.8〜1.2人日 |
| Execution Result/schema/capability | 0.4〜0.6人日 |
| contract/integration/regression/platform test、fixture | 1.3〜1.8人日 |
| spec/README/CHANGELOG/version/pack/SEA/review修正 | 0.7〜1.0人日 |
| **kSQL-Flow側合計** | **5.5〜8.1人日** |

上流仮置き3〜5人日より2.5〜3.1人日上振れし得る。実コード調査により、(1) contextがexecutor内部でdisposeされる、(2) file writeをJOB終了確定前へ組み込む必要がある、(3) 既存Execution Result writerは上書き禁止で流用できない、(4) SJIS dependencyが通常npm CLIとSEAの両配布面へ影響する、(5) Windows `EPERM`・short write・複数targetの部分commit testが必要、と判明したためである。engine B179自体の7〜12人日は含まない。FlowNetとのoutputs E2Eは別途0.5〜1.0人日を見込む。

## 11. 実装順と完了条件

### 11.1 実装順

1. engine B179実装branchで公開型/value/error codeを確認し、`/flow` consumer smokeを作る。
2. CLI parserとexport入力の純粋preflightを実装し、API/file 0のcontract testをgreenにする。
3. `encoding-japanese@2` wrapperを実装し、engine CLI fixtureと成功bytes、U+301C等のfail-closedを固定する。
4. atomic writerを独立実装し、write/fsync/close/rename/EPERM/short write/cleanup testをgreenにする。
5. registryとexecutorを配線し、context作成、全statement、status、全serialize、dispose、commit、JOB終了の順を固定する。
6. Execution Result type/schema/fixture/normalizerを更新し、旧fixture互換と成功/失敗/partial receiptを固定する。
7. named/単文、EXIT、IMPORT+EXPORT、stdout純度、同一sha再実行を通す。
8. 文書、version、engine/dependency lock、pack、SEA、複数OS/Node、実機を検証する。
9. 最後にだけ `features.resultCsv:true` を追加し、capabilities/full/pack/SEA suiteを再実行する。

### 11.2 完了条件

1. `run` がrepeatable named sinkと単文SELECT path形式を契約どおり受け、engine公開serializerだけでCSVを生成する。
2. sink名/target重複、不存在、DROP済み、名前なし複文/DMLは最初のSQL/API/file操作前に拒否される。
3. 全statementとEXIT後skipを回収後、materializedだけをserializeし、not-createdはfile/receiptなし、旧file/NO_DATAを維持する。
4. 全materialized sinkのserialize成功前にfileを触らず、writerは同一directory temp -> 全量write -> fsync -> close -> renameを守る。
5. Windows `EPERM` 等で旧file維持、一時file cleanup、non-zeroとなり、削除後renameへfallbackしない。
6. SJISは`encoding-japanese@2`とround-trip完全一致を使い、表現不能/別文字化を完成fileへ残さない。
7. `output_files` はrename済みbytesと同じ`data`由来のsha256、bytes、rows、encodingだけを持ち、path/内容/秘密を含まない。
8. orchestrator stdoutはExecution Result 1 object + LFだけで、CSV stdoutを一切許さない。
9. engine v3.77.0 registry package、通常npm CLI、Windows SEA、Node 18/20/22、Windows/Linuxの受入と既存全suiteがgreenである。
10. package/lock/spec/README/CHANGELOG/version/互換表が0.9.0 / ^3.77.0で一致し、そのbuildだけが `features.resultCsv:true` を返す。
