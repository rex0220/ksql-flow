-- @ksql name: monthly_sales_sync
-- @ksql depends_on: sync_master_customers
-- @ksql timeout: 600
-- @ksql dialect: 1
-- ========================================================
-- 月次売上集計・顧客マスタ同期パイプライン（設計書 3.1 のサンプル）
-- ========================================================

-- Step 1: 事前データ整合性チェック（業務異常 → 中断して通知）
ASSERT (
  SELECT COUNT(*) FROM LAPP_受注
  WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START()
    AND 金額 < 0
) = 0, '【異常中断】マイナスの売上データが存在するため処理を停止しました';

-- Step 2: インメモリ一時テーブルへの集計（kintone API を消費せず高速処理）
CREATE TEMP TABLE temp_monthly_summary AS
SELECT
  顧客コード,
  COUNT(レコード番号) AS 受注件数,
  SUM(金額) AS 当月売上合計
FROM LAPP_受注
WHERE 受注日 >= @MONTH_START() AND 受注日 < @NEXT_MONTH_START()
  AND ステータス = '受注完了'
GROUP BY 顧客コード;

-- Step 3: 対象 0 件は「正常な早期終了」（通知を発報しない）
EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_monthly_summary) = 0,
  '集計対象となる受注データが 0 件のためスキップ';

-- Step 4: 顧客マスタへの一括 UPSERT 反映（冪等性の担保）
UPSERT INTO LAPP_顧客マスタ (顧客コード, 当月受注件数, 当月売上実績, 最終集計日時)
SELECT
  顧客コード,
  受注件数,
  当月売上合計,
  @NOW()
FROM temp_monthly_summary
KEY (顧客コード);
