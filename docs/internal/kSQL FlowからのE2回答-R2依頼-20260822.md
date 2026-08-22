# kSQL Flow からの回答 — E-2 dry-run 設計提案 R1 / R2 確定依頼

- 日付: 2026-08-22 ／ 差出: ksql-flow ／ 宛先: kintone-sql-tools（kSQL エンジン）
- 対象: `kSQLエンジンからの設計提案-E2-dryrun-20260821.md`（提案 R1）
- ステータス: R1 回答済み・R2 確定依頼

## 0. 結論

`previewStatement` を既存 `executeStatement` とは分離する案に賛成します。初版は unchanged 判定を含めず、サンプルは既定 5 件・上限 50 件、DELETE も対象としてください。ランナーは単一の `ExecutionContext` で文を順に処理し、read-only 文を `executeStatement`、DML を `previewStatement` へ振り分けます。これにより、それ以前の `CREATE TEMP TABLE` / SET 等で形成された状態を後続 DML の preview が利用できます。

設計書 v2.7 §10.2 へ写像するため、操作別件数（INSERT / UPDATE / DELETE）、キー値と before → after の変更サンプル、preview の実読取 API 数、本実行時の推定書込 API 数が必要です。preview 中に実消費した API は、設計書 §7.2 の単一 HTTP カウンタで、ログ・ロック等と同じ経路から計上します。

## 1. 質問 5 件への回答

### Q1. `counts.unchanged` は初版から必須か

**回答: 必須ではありません。R1 の初版除外案を採用します。**

設計書 §10.2 が必須とするのは INSERT / UPDATE / DELETE の予定件数であり、unchanged は表示契約に含まれていません。初版の `counts.update` は「キー一致して UPDATE 対象となる件数」と明記してください。型別の正規化なしに before / after の文字列表現だけで unchanged を判定すると誤判定し得るため、将来追加する場合は数値・日時・選択肢・配列等の比較規則を先に合意します。

### Q2. `maxSamples` の既定 5・上限 50 で足りるか

**回答: 足ります。既定 5、上限 50 を採用してください。**

設計書 §10.2 の表示例は「先頭 5 件」であり、既定 5 はそのまま写像できます。ランナーは将来 CLI オプションで 1〜50 を受け、未指定時は 5 を渡す想定です。エンジン側でも整数 1〜50 を検証し、範囲外は書込や読取を始める前に `ArgumentError` とする案を推奨します。

### Q3. DELETE サンプルはキー相当列のみで足りるか

**回答: 初版はキー相当列のみで足ります。ただし DELETE を preview 対象から外さないでください。**

DELETE の主目的は削除対象の同定と誤削除スコープの確認です。全列 before は読取量・ログ上の機微情報・マスキング負荷を増やすため初版では不要です。`samples[].kind = "delete"` と、対象を同定できる `key`（DELETE に業務キー宣言がなければレコード番号または `$id` 相当）を返してください。`before` は省略可とします。将来、全列取得が必要という実例が出た場合は opt-in 拡張を別途検討します。

### Q4. 「推定所要時間」はランナー側算出でよいか

**回答: はい。ランナー側で算出します。**

エンジンは `reads` と `estimatedWrites` を返し、ランナーがログ・ロック分を加えた API 総数と、実行環境または過去実績に基づく時間モデルから表示値を作ります。preview で実際に消費した API の正は `previewStatement` の `reads` だけではなく、ランナーの fetch ラッパーを通る設計書 §7.2 の単一カウンタです。エンジン内部の全読取が同じ注入済み client / fetch を通る限り、追加 hook は不要です。

### Q5. DML のみ preview・他の文は実行する方式に支障はないか

**回答: 支障ありません。この方式を採用します。**

ランナーはスクリプトを先頭から単一の `ExecutionContext` で処理し、SELECT / ASSERT / EXIT / CREATE TEMP TABLE / SET 等の read-only 文を `executeStatement`、INSERT / UPDATE / DELETE / UPSERT を `previewStatement` に振り分けます。これにより ASSERT / EXIT のゲートを dry-run でも有効にし、前段で実体化した TEMP TABLE を後続 DML preview が参照できます。書込 API は DML preview から一切発行しません。

R1 の API 宣言は `previewStatement(...): Promise<PreviewResult>` である一方、「非 DML を渡した場合は通常どおり実行」とあるため、戻り値型が曖昧です。**R2 では `previewStatement` は DML 専用とし、非 DML は呼出側が `executeStatement` へ振り分ける契約を推奨します。** エンジン側が非 DML 受理を必要と判断する場合は `Promise<PreviewResult | StatementResult>` の discriminated union が代案ですが、分岐責務が重複するため第一案にはしません。見解が割れる場合は裁定者 Takashi に上げますが、ランナー推奨は DML 専用です。

## 2. R2 へ明記を依頼する契約

1. `counts` は INSERT / UPDATE / DELETE を常に持ち、§10.2 の操作別表示へ直接写像できること。
2. `samples` は既定 5、上限 50。INSERT / UPDATE / UPSERT は可能なキー値と before / after、DELETE は削除対象キーを返すこと。
3. `reads` は preview が実消費した読取 API 数、`estimatedWrites` は本実行時の 100 件単位の推定書込 API 数であること。実消費の上限制御は注入 client の fetch を通じたランナー単一カウンタで行えること。
4. 渡された `ExecutionContext` の TEMP TABLE・変数・as-of / timezone 状態をそのまま参照できること。preview 後も同じ context で後続文を処理できること。
5. preview は書込 API を 0 回に保ち、TOCTOU、kintone 自動設定値、lookup 連動値が保証外であること。
6. `PreviewSample` の値はランナーの `logging.maskFields` / `stripLiterals` 適用前のデータであり、ログ・画面出力前のマスキング責務はランナー側にあること。

以上の内容で R2 の確定をお願いします。
