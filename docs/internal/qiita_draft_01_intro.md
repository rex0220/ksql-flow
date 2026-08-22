# kintone のバッチ処理を SQL 1 本で書けるランナー「kSQL Flow」の紹介

> **as-is / no support**: 本ツールは MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証・修正の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、自己責任でお願いします。

- GitHub: https://github.com/rex0220/ksql-flow
- npm: `npm i -g @rex0220/ksql-flow`

## kintone のバッチ処理、どう書いていますか

kintone でアプリ間集計や定期データ更新（月次売上をマスタへ反映する、ような処理）には、いくつかの選択肢があります。

1. **クラウド型 ETL サービス** — ノーコードで即日構築でき、実行基盤の運用もお任せできる
2. **自作の JavaScript / REST API スクリプト** — 自由度が高い一方、リトライ・排他制御・失敗時のリランといった運用まわりは自分で作り込むことになる

どちらも選択肢としてある中で、kSQL Flow は「**定義は SQL 1 本・Git で管理し、実行環境と認証情報は自分の手元に置きたい**」という好みの人向けに作った、もう一つの選択肢です。実行・排他・リラン・実行ログ・リトライ・通知といった「バッチの面倒な部分」はランナーが引き受けます。実行場所は自分の環境（ローカル / 社内サーバー / GitHub Actions / Docker）で、**通信先は設定した kintone と通知 Webhook だけ**。テレメトリの類はありません（BYOC: Bring Your Own Cloud）。その代わり、実行基盤の構築・監視・トークン管理は自分の責務になります — このトレードオフを受け入れられる開発者・情シスの方が対象です。

SQL の解析・実行エンジンは、以前紹介した [kintone-sql-tools](https://github.com/rex0220/kintone-sql-tools)（kSQL）の公式 API を使っています。つまり **MCP で AI に SQL を書かせて、同じ方言でバッチも動かせる**構成です（この話は次回）。

## ジョブは SQL ファイル 1 本

月次売上を顧客マスタへ反映するジョブの全文です。

```sql
-- @ksql name: monthly_sales_sync
-- @ksql timeout: 600
-- @ksql dialect: 1

-- Step 1: 業務異常があれば安全停止（アラート対象）
ASSERT (
  SELECT COUNT(*) FROM LAPP_受注
  WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START()
    AND 金額 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

-- Step 2: インメモリ一時テーブルへ集計（この間 kintone API は消費しない）
CREATE TEMP TABLE temp_monthly_summary AS
SELECT 顧客コード, COUNT(レコード番号) AS 受注件数, SUM(金額) AS 当月売上合計
FROM LAPP_受注
WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START()
  AND ステータス = '受注完了'
GROUP BY 顧客コード;

-- Step 3: 対象 0 件は「正常な早期終了」（アラートを鳴らさない）
EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる受注データが 0 件のためスキップ';

-- Step 4: キー指定 UPSERT（何度リランしても同じ結果になる = 冪等）
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
SELECT 顧客コード, 受注件数, 当月売上合計, @NOW()
FROM temp_monthly_summary
KEY (顧客コード);
```

設計上こだわったポイントを 3 つだけ。

**① 「異常」と「対象なし」を言葉から分ける。** `ASSERT` は業務異常（マイナス売上）で止めてアラートを鳴らす。`EXIT SUCCESS IF` は対象 0 件の正常スキップで、アラートは鳴らさない。ここを混ぜると月初や休日のたびに誤アラートが飛び、そのうち誰もアラートを見なくなります。

**② 時刻は「バッチ開始時」に固定。** `@MONTH_START()` や `@NOW()` は実行のたびに時計を読むのではなく、バッチ開始時に確定した基準時刻（as-of）から導出します。日跨ぎの長時間実行でも Step 間で基準がズレず、`--as-of "2026-07-01T00:00:00+09:00"` と指定すれば**過去日付での再集計（バックフィル）も同じ SQL で再現**できます。

**③ 冪等が復旧戦略。** kintone にトランザクションはありません（書込の原子性は 100 レコード/リクエスト単位）。だからこそキー指定 UPSERT を標準にして、「失敗したら同じジョブをもう一度流せば正しい状態に収束する」ことを復旧の基本にしています。
（注: リランで収束するのは UPSERT が書き込むキーの範囲です。**誤ったデータで追加されてしまったレコードは、リランしても削除されません**。除去が必要な場合は、スコープを限定した DELETE 文をジョブに含めるか、手動で対処します）

## 実行は 3 段階: validate → dry-run → run

```bash
ksql-flow validate -f jobs/monthly_sales_sync.sql --profile prod   # スキーマ依存の検証まで
ksql-flow run -f jobs/monthly_sales_sync.sql --profile prod --dry-run
ksql-flow run -f jobs/monthly_sales_sync.sql --profile prod
```

`--dry-run` は「実行しないこと」ではなく「**実行したら何が起きるかを見せること**」が主眼です。書込ゼロで実レコードとの差分を出します。

```
[DRY-RUN] monthly_sales_sync.sql (as-of: 2026-08-22T00:00:00.000Z)
  読み取り        : 276 件（API 5 回）
  書き込み予定    : LAPP_顧客マスタ  INSERT 1 件 / UPDATE 1 件 / DELETE 0 件
  実測 API 消費   : 6 回（読取 5 + preview 照合 1）
  変更サンプル（先頭 5 件）:
    顧客コード=C0012  当月売上実績: 1,200,000 → 1,450,000
    顧客コード=C0034  (新規) 当月売上実績: 380,000
  => dry-run 完了（kintone 書き込み 0 件）
```

`ASSERT` 違反や `EXIT SUCCESS IF` の判定は dry-run でも本実行と同じに効くので、`--json` 出力を CI に流して PR コメントに貼る、という使い方ができます（Exit Code も本実行と同じ）。

## 運用の面倒な部分はランナーが持つ

| 装備 | 内容 |
| --- | --- |
| 実行ログ | kintone の「実行ログアプリ」へ毎回記録（同梱テンプレートから 1 分で作成）。メトリクス・エラー・Git リビジョンまで残る |
| 多重起動の排他 | ログアプリの重複禁止フィールドを分散ロックに使用。二重起動は Exit 5 で即停止 |
| リラン | `run-all --resume` が失敗ジョブだけを**元の as-of で**再実行 |
| リトライ | 429 / 5xx を指数バックオフ + Retry-After で自動再試行（認証エラーは即停止） |
| API 上限 | 読み書き・ログ・ロック・リトライまで含む単一カウンタで `maxApiCalls` を強制。暴走でアプリの API 枠を食い潰さない |
| 通知 | 失敗時 Webhook（対象 0 件では鳴らさない）+ 完走 heartbeat |
| Exit Code | 0=成功 / 1=検証 / 2=業務異常 / 3=実行時 / 4=部分成功 / 5=多重起動 — スケジューラや CI で分岐可能 |

設定は JSON 1 枚で、トークンは `env:` 参照（ファイルに平文を書かない）。存在しないキーや typo したフラグは**実行前に Exit 1** で止まる fail-closed 設計です。

## インストールと実行環境

```bash
npm i -g @rex0220/ksql-flow   # Node.js 18+
```

定期実行は好きな場所で: **GitHub Actions**（サーバーレスで無料枠運用）/ **Windows タスクスケジューラ**（社内サーバーの本命）/ **cron / Docker**。それぞれのセットアップ例はリポジトリの [examples/](https://github.com/rex0220/ksql-flow/tree/main/examples) にあります。

詳細な仕様（実行モデル・ロック・リラン・ログ設計）は[公開仕様書](https://github.com/rex0220/ksql-flow/blob/main/docs/ksql_flow_spec.md)にまとめてあります。ちなみに開発は実装 AI と レビュー AI の 2 体制で行い、レビュー往復や実機検証の記録も[そのまま公開](https://github.com/rex0220/ksql-flow/tree/main/docs/internal)しています（この話もいつか書くかもしれません）。

## 今後の連載予定

1. **本記事**: 紹介とコンセプト
2. **AI にジョブを書かせる**: MCP でスキーマを渡して SQL を生成 → validate 二段構え → dry-run を人間の最終レビューにする
3. **タスクスケジューラで毎朝動かす**: ②で作ったジョブを Windows で実運用へ（実機で踏んだ罠 2 連発つき）
4. 以降、GitHub Actions / cron・Docker / AWS / Azure / GCP の環境別と、排他・冪等リランの設計深掘りを予定

質問への回答はお約束できませんが（as-is）、感想・活用報告は歓迎です。
