# kSQL Flow からの申し送り — fix4 dry-run 本実装完了・台帳同期

- 日付: 2026-08-22 ／ 差出: ksql-flow ／ 宛先: kintone-sql-tools（kSQL エンジン）
- 対象エンジン: v3.71.0 (`@rex0220/kintone-sql-tools/flow`)
- 対象契約: E-2 `previewStatement` R2 確定仕様

## 1. ① dry-run 本実装の完了

kSQL Flow fix4 で、縮退していた EXPLAIN 表示を差分プレビューへ置き換えました。

- 単一 `ExecutionContext` で read-only 文を `executeStatement`、DML を `previewStatement` へ振り分け
- ASSERT 違反を ABORTED / Exit 2、EXIT SUCCESS IF 成立を NO_DATA / Exit 0 として打ち切り
- EXIT 成立は直前の `executeStatement` 結果で判定し、成立後の DML は呼び出さない（v3.71.0 の全ゼロ PreviewResult 契約も認識済み）
- INSERT / UPDATE / DELETE 件数、実測 API 消費、before / after、DELETE キーサンプルを表示
- `--sample 1..50`（既定 5）、`--json`、`run-all --dry-run` を実装
- `logging.maskFields` / `stripLiterals` をコンソール・JSON・ローカル JSONL のサンプルへ適用
- dry-run HTTP ガードで kintone 変更系 POST / PUT / DELETE を下位 fetch 前に遮断
- 分散ロック、ログアプリ、state 更新なし。読み取りには `maxApiCalls` を適用し、超過時は既取得プレビューを残して Exit 3

R2 確定契約との差異はありません。R2 外で申し送られた「EXIT 成立後の preview は全ゼロ」もランナーの打ち切り判定と整合しています。新規裁定はありません。

検証結果: ksql-flow の `npm test` は 9 suites / 100 tests 成功（既存 93 件から 7 件純増）、`npm run build` 成功。dry-run 後の mutation request が 0 件であることを結合テストと HTTP ガード単体テストの双方で確認しました。

## 2. ② Q3 縮退解除は fix3 でクローズ済み

v3.70.0 の `onChunkWritten` / `lastKeyValue` を fix3 で採用済みです。`last_written_key` はキー値ベースへ移行し、25 チャンクまたは 60 秒のログアプリ間引きとローカル JSONL 毎チャンク記録を維持しています。`chunk:<n>` はキー値を取得できない操作の診断用フォールバックだけです。

## 3. ③ 要対応 2 件は fix3 でクローズ済み

1. metrics 差分集計: 判定 **(a)**。fix2 までの JOB 集計は末尾累積値 / 公開 DML 結果 / HTTP 単一カウンタを使っており、過去ログ訂正は不要でした。v3.70.0 以降は deep-copy 累積 snapshot の前文差分で文単位 metrics を記録しています。
2. `last_written_key` 単調性: 裁定 Q7 により、順序保証なしの診断情報へ確定済みです。復旧ウォーターマークや途中再開位置には使用せず、冪等リランを正とします。

以上により、エンジン側台帳の ①〜③はすべてクローズとして同期をお願いします。
