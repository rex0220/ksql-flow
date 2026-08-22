-- @ksql name: resume_failure
-- @ksql depends_on: resume_success
-- @ksql timeout: 600
-- @ksql dialect: 1

CREATE TEMP TABLE temp_resume_summary AS
SELECT 会社名, COUNT(案件No_) AS 案件件数
FROM LAPP_案件管理
WHERE 会社名 LIKE 'KSQL-FLOW-TEST-%'
GROUP BY 会社名;

UPSERT INTO LAPP_顧客管理 (会社名, 顧客情報メモ欄)
SELECT 会社名, CONCAT('kSQL Flow resume 検証: ', 案件件数, ' / as-of ', @NOW())
FROM temp_resume_summary
KEY (会社名);
