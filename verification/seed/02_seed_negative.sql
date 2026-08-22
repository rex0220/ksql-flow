-- @ksql name: seed_negative
-- @ksql depends_on: seed_normal
-- @ksql timeout: 300
-- @ksql dialect: 1

-- ASSERT 異常系専用。次セッションでログアプリ準備後にのみ実行する。
INSERT INTO LAPP_案件管理 (案件名, 会社名, 売上, 詳細)
VALUES ('KSQL-FLOW-TEST-DEAL-NEGATIVE-001', 'KSQL-FLOW-TEST-CUSTOMER-001', -1, 'DUMMY-NEGATIVE-TEST-DATA');
