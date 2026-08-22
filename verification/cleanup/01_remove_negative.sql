-- @ksql name: remove_negative
-- @ksql timeout: 300
-- @ksql dialect: 1

DELETE FROM LAPP_案件管理
WHERE 案件名 = 'KSQL-FLOW-TEST-DEAL-NEGATIVE-001';
