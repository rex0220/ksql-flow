-- @ksql name: resume_success
-- @ksql timeout: 300
-- @ksql dialect: 1

SELECT COUNT(*) AS 担当者件数
FROM LAPP_担当者管理;
