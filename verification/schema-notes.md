# Phase 0 実測スキーマ

- 実測日: 2026-08-22
- 取得方法: `@rex0220/kintone-sql-tools/flow` の公式 `createKintoneClient(...).getFields(appId)`
- 接続先表記: `https://<dev>.cybozu.com`（実ドメイン・トークンは記録しない）
- 記録範囲: フィールドコードと型のみ。レコードの実データ値は取得・記録していない。

## 活動履歴（4245）

| フィールドコード | 型 |
| --- | --- |
| カテゴリー | CATEGORY |
| ステータス | STATUS |
| タイトル | SINGLE_LINE_TEXT |
| レコード番号 | RECORD_NUMBER |
| 案件No | NUMBER |
| 案件情報 | REFERENCE_TABLE |
| 案件名 | SINGLE_LINE_TEXT |
| 会社名 | SINGLE_LINE_TEXT |
| 関連活動履歴 | REFERENCE_TABLE |
| 顧客No | NUMBER |
| 更新者 | MODIFIER |
| 更新日時 | UPDATED_TIME |
| 作業者 | STATUS_ASSIGNEE |
| 作成者 | CREATOR |
| 作成日時 | CREATED_TIME |
| 所属組織 | ORGANIZATION_SELECT |
| 対応者 | USER_SELECT |
| 対応種別 | DROP_DOWN |
| 対応日付 | DATE |
| 添付ファイル | FILE |
| 内容 | MULTI_LINE_TEXT |

## 顧客管理（4246）

| フィールドコード | 型 |
| --- | --- |
| FAX | LINK |
| Webサイト | LINK |
| カテゴリー | CATEGORY |
| ステータス | STATUS |
| 案件一覧 | REFERENCE_TABLE |
| 会社名 | SINGLE_LINE_TEXT |
| 活動履歴一覧 | REFERENCE_TABLE |
| 業種 | DROP_DOWN |
| 建物名 | SINGLE_LINE_TEXT |
| 顧客No | RECORD_NUMBER |
| 顧客ランク | RADIO_BUTTON |
| 顧客情報メモ欄 | MULTI_LINE_TEXT |
| 更新者 | MODIFIER |
| 更新日時 | UPDATED_TIME |
| 作業者 | STATUS_ASSIGNEE |
| 作成者 | CREATOR |
| 作成日時 | CREATED_TIME |
| 支払日 | DROP_DOWN |
| 住所 | SINGLE_LINE_TEXT |
| 担当者一覧 | REFERENCE_TABLE |
| 締め日 | DROP_DOWN |
| 電話番号 | LINK |
| 都道府県 | DROP_DOWN |
| 郵便番号 | SINGLE_LINE_TEXT |

UPSERT キー候補の `会社名` は `SINGLE_LINE_TEXT` で、「値の重複を禁止する」が有効だった。

## 案件管理（4247）

| フィールドコード | 型 |
| --- | --- |
| アクション担当者 | USER_SELECT |
| アクション内容 | SINGLE_LINE_TEXT |
| カテゴリー | CATEGORY |
| ステータス | STATUS |
| 案件No_ | RECORD_NUMBER |
| 案件名 | SINGLE_LINE_TEXT |
| 会社名 | SINGLE_LINE_TEXT |
| 確度 | DROP_DOWN |
| 活動履歴 | REFERENCE_TABLE |
| 契約書_申込書 | FILE |
| 顧客No_ | NUMBER |
| 更新者 | MODIFIER |
| 更新日時 | UPDATED_TIME |
| 作業者 | STATUS_ASSIGNEE |
| 作成者 | CREATOR |
| 作成日時 | CREATED_TIME |
| 次回アクション日 | DATE |
| 主担当 | USER_SELECT |
| 主担当組織 | ORGANIZATION_SELECT |
| 受注予定日 | DATE |
| 初回商談日 | DATE |
| 商談フェーズ | DROP_DOWN |
| 詳細 | MULTI_LINE_TEXT |
| 提案商品 | DROP_DOWN |
| 同一顧客向け案件 | REFERENCE_TABLE |
| 売上 | NUMBER |

## 担当者管理（4248）

| フィールドコード | 型 |
| --- | --- |
| お名前 | SINGLE_LINE_TEXT |
| お名前_フリガナ | SINGLE_LINE_TEXT |
| カテゴリー | CATEGORY |
| ステータス | STATUS |
| メールアドレス | LINK |
| 携帯番号 | LINK |
| 決裁権 | RADIO_BUTTON |
| 顧客No_ | NUMBER |
| 顧客名 | SINGLE_LINE_TEXT |
| 更新者 | MODIFIER |
| 更新日時 | UPDATED_TIME |
| 作業者 | STATUS_ASSIGNEE |
| 作成者 | CREATOR |
| 作成日時 | CREATED_TIME |
| 姓 | SINGLE_LINE_TEXT |
| 姓_フリガナ | SINGLE_LINE_TEXT |
| 担当者No_ | RECORD_NUMBER |
| 添付ファイル_名刺等 | FILE |
| 電話番号 | LINK |
| 同一企業担当者 | REFERENCE_TABLE |
| 備考 | MULTI_LINE_TEXT |
| 部署 | SINGLE_LINE_TEXT |
| 名 | SINGLE_LINE_TEXT |
| 名_フリガナ | SINGLE_LINE_TEXT |
| 役職 | SINGLE_LINE_TEXT |
