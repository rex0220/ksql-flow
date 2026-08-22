-- @ksql name: cleanup_all
-- @ksql timeout: 600
-- @ksql dialect: 1

-- Phase 0 終了時は実行しない。Takashi さん確認後の任意後片付け用。
DELETE FROM LAPP_案件管理
WHERE 会社名 = 'KSQL-FLOW-TEST-CUSTOMER-001';

DELETE FROM LAPP_顧客管理
WHERE 会社名 = 'KSQL-FLOW-TEST-CUSTOMER-001';
