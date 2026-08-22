# 設計提案: E-2 dry-run（書込抑止・差分プレビュー）— 実装前の往復用

- 日付: 2026-08-21 ／ 差出: kintone-sql-tools（kSQL エンジン）／ 宛先: ksql-flow
- 位置づけ: [依頼書 E-2](../../../kintone-sql-tools/docs/flow_engine_requests_20260821.md) の「実装前に設計提案を文書で往復」への提案。
- ステータス: ✅ **R2 確定（2026-08-22・[ksql-flow 回答](../../../kintone-sql-tools/docs/flow_e2_dryrun_reply_20260822.md) を全面採用）→ 実装へ**。R1 からの確定差分は末尾「R2 確定事項」を参照。

## 0. 前提の訂正（実測）

依頼書の「UPSERT の pre-read 結果を流用すれば差分算出の大部分は賄える」は**成立しません**。
pre-read（`resolveUpsertTargets`）が取得するのは **`$id` とキー列のみ**で、更新対象列の before 値・
レコード本体を持ちません。dry-run の差分算出には **read-set の拡張（追加の読取 API 消費）が必須**です。
規模は依頼書の「大」ではなく**大〜特大**と見積もります — それでも設計書 10.2 の価値は認めるので、
範囲を絞った初版を提案します。

## 1. API 形の提案

**新関数 `previewStatement`（既存 `executeStatement` は一切変えない）**:

```ts
previewStatement(
  statement: Statement,
  context: ExecutionContext,
  opts?: { maxSamples?: number }          // 既定 5
): Promise<PreviewResult>

interface PreviewResult {
  kind: "PREVIEW";
  operation: "INSERT" | "UPDATE" | "DELETE" | "UPSERT";
  appId: number;
  counts: { insert: number; update: number; delete: number };
  samples: PreviewSample[];               // 書込順の先頭 maxSamples 件
  reads: number;                          // preview が実消費した読取 API 回数
  estimatedWrites: number;                // 本実行したときの書込 API 回数（ceil(N/100)）
}

interface PreviewSample {
  kind: "insert" | "update" | "delete";
  key?: string;                           // UPSERT キー等・判明する場合のみ
  before?: Record<string, string>;        // 変更対象列のみ（update/delete）
  after?: Record<string, string>;         // 書き込む値（insert/update）
}
```

- 別関数にする理由: `executeStatement` の戻り値契約（`StatementResult`）を暗黙に変えず、
  「preview は別物」と型で明示できるため。context のモード切替（`{ dryRun: true }`）案は、
  同じ関数が別型を返す形になり利用側の分岐が濁るので採りません
- SELECT / ASSERT / EXIT / CREATE TEMP TABLE を渡した場合は**通常どおり実行**します
  （読み取り系は preview の概念がなく、ASSERT / EXIT のゲート判定と一時テーブルの実体化は
  後続 DML の preview に必要なため）。つまりランナーの `--dry-run` は
  「文リストを順に回し、DML だけ `previewStatement`・それ以外は `executeStatement`」になります

## 2. 差分算出の方式

| 操作 | before の取得 | after の算出 |
|---|---|---|
| UPSERT | pre-read を**拡張**し、キー列に加えて**代入対象列**を取得（追加読取） | 既存の値評価（fields × select/values）をそのまま流用 |
| UPDATE | 既存の対象取得（現行実装が対象レコードを取得済み）に**代入対象列**を含める | 既存の `updateToPutBatchesArith` 系の評価結果 |
| DELETE | 既存の対象取得（`$id`）に**キー相当列（レコード番号）**を追加 | なし |
| INSERT | なし（新規） | 書き込む値そのまま |

- **無変更判定（unchanged）は初版に含めません**。before = after 比較には型ごとの正規化規則
  （数値の表記ゆれ・選択肢・日時）が要り、誤判定のリスクが高いためです。
  counts の update は「キー一致した件数」です（本実行と同じ意味）
- APPLY・IMPORT・サブテーブルは初版対象外（dialect 1 では大半が禁止/範囲外）

## 3. 契約上の明示事項（設計書との整合）

- **preview は読取 API を実消費**します（`reads` で報告・設計書 10.2 の記述と整合）。書込は 0 回
- **preview は保証ではなく参考値**です（preview と本実行の間の他更新＝TOCTOU は防げない）
- サンプルの before / after は**フィールド値を含む**ため、ログへのマスキング
  （設計書 8.4 `maskFields` / `stripLiterals`）は**ランナー側の責務**とします
- kintone が自動設定する値（作成日時等）・lookup の連動コピーは after に**含みません**
  （本実行後の値と一致しない場合がある旨を型コメントに明記）

## 4. 見積り

read-set 拡張・preview 用の実行器分岐・4 操作 × サンプル構築・テストで**大**（B168 の 1 Stage 相当以上）。
E-6 / E-3 / E-5 / E-1（対応中）とは独立に実装できます。

## 5. ksql-flow への質問（往復事項）

1. `counts` に `unchanged` が**初版から必須**か（§2 のとおり初版除外を提案。必要なら型正規化規則の合意が先）
2. `maxSamples` の既定 5・上限（提案: 50）で足りるか
3. DELETE のサンプルは「キー相当列のみ」で足りるか、全列 before が要るか（全列は読取消費が増える）
4. 設計書 10.2 の表示例にある「推定所要時間」はランナー側算出（reads / estimatedWrites から）の理解で良いか
5. ランナーの `--dry-run` を §1 の「DML のみ preview・他は実行」方式で実装することに支障はないか
   （ASSERT / EXIT のゲートが dry-run でも効く＝設計書 ①② の整合を意図しています）

回答を受けて R2 を確定し、実装に着手します。

---

## R2 確定事項（2026-08-22・ksql-flow 回答を反映）

1. **`previewStatement` は DML 専用**（Q5 回答の第一案を採用）。INSERT / INSERT...SELECT / UPDATE /
   UPDATE...FROM / DELETE / UPSERT / UPSERT...SELECT（MERGE 正規化後を含む）のみ受理し、
   非 DML・`VALIDATE ONLY` / `ON ERROR SKIP` 付き・APPLY・IMPORT・サブテーブルターゲットは
   `ArgumentError`。振り分け（read-only 文 → `executeStatement`）は呼出側の契約
2. `counts` は `{ insert, update, delete }` を**常に**持つ（§10.2 へ直接写像）。`update` は
   「キー一致して UPDATE 対象となる件数」（unchanged 判定は初版に含めない）
3. `samples` は既定 5・**上限 50**。整数 1〜50 以外は**読取開始前に** `ArgumentError`。
   INSERT / UPDATE / UPSERT はキー値（可能な場合）と before / after（**代入対象列のみ**）、
   DELETE は削除対象キー（業務キー宣言がなければ `$id`）のみ・`before` 省略
4. `reads` = preview が実消費した読取 API 数（追加 hook 不要＝注入 client を全読取が通るため、
   ランナーの単一カウンタでも計上可能）。`estimatedWrites` = 本実行時の 100 件単位の推定書込 API 数
5. 渡された `ExecutionContext` の TEMP TABLE・変数・as-of / timezone をそのまま参照し、
   **preview 後も同じ context で後続文を処理できる**
6. preview は**書込 API 0 回**（エンジン内部で書込ブロックを構造的に保証）。TOCTOU・kintone 自動設定値・
   lookup 連動値は保証外。`PreviewSample` の値はマスキング前データ＝ログ/画面出力前の
   マスキング責務はランナー側（`logging.maskFields` / `stripLiterals`）
