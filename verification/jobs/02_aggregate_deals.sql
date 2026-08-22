-- @ksql name: aggregate_deals
-- @ksql depends_on: sync_masters
-- @ksql timeout: 600
-- @ksql dialect: 1

-- 検証用プレフィックスに限定し、既存の実データを集計・更新対象にしない。
ASSERT (
  SELECT COUNT(*)
  FROM LAPP_案件管理
  WHERE 会社名 LIKE 'KSQL-FLOW-TEST-%'
    AND 売上 < 0
) = 0, '検証データにマイナス売上が存在するため処理を停止しました';

CREATE TEMP TABLE temp_deal_summary AS
SELECT
  会社名,
  COUNT(案件No_) AS 案件件数,
  SUM(売上) AS 売上合計
FROM LAPP_案件管理
WHERE 会社名 LIKE 'KSQL-FLOW-TEST-%'
GROUP BY 会社名;

EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_deal_summary) = 0,
  '検証対象の案件データが 0 件のためスキップ';

UPSERT INTO LAPP_顧客管理 (会社名, 顧客情報メモ欄)
SELECT
  会社名,
  CONCAT(
    'kSQL Flow 検証集計: ', 案件件数,
    ' 件 / 売上合計 ', 売上合計,
    ' / as-of ', @NOW()
  )
FROM temp_deal_summary
KEY (会社名);
