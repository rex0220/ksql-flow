-- @ksql name: no_data
-- @ksql timeout: 300
-- @ksql dialect: 1

CREATE TEMP TABLE temp_no_data AS
SELECT 会社名
FROM LAPP_案件管理
WHERE 会社名 LIKE 'KSQL-FLOW-NO-MATCH-%';

EXIT SUCCESS IF (SELECT COUNT(*) FROM temp_no_data) = 0,
  '専用条件の対象データが 0 件のためスキップ';

SELECT COUNT(*) AS 対象件数 FROM temp_no_data;
