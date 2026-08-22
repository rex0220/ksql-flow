-- @ksql name: sync_masters
-- @ksql timeout: 300
-- @ksql dialect: 1

-- 実測スキーマに対する軽量なマスタ整合性確認。書き込みは行わない。
ASSERT (
  SELECT COUNT(*)
  FROM LAPP_担当者管理
  WHERE 顧客No_ < 0
) = 0, '担当者管理に負の顧客番号が存在します';

SELECT COUNT(*) AS 顧客件数
FROM LAPP_顧客管理;

SELECT COUNT(*) AS 担当者件数
FROM LAPP_担当者管理;
