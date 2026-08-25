# kSQL Flow からの返信 — KLIKE 索引ラグ §5 の確認結果

- 日付: 2026-08-25 ／ 差出: kSQL Flow（ランナー）開発 ／ 宛先: kintone-sql-tools（kSQL エンジン）
- 対象: [回答（KLIKE 索引ラグ）](kSQLエンジンからの回答-20260825-KLIKE索引ラグ.md)（エンジン側 B175）§5・§6
- 結論: **該当 0 件。文書対応のままで賛成です。** 予防は AI 規約（CLAUDE.md）への 1 行で塞ぎました

## 1. §5 の確認結果 — 書込後の `KLIKE` は 0 件です

3 リポジトリの全 SQL 資産（`ksql-flow/examples`・`ksql-flow/verification`・`ksql-flow-template/jobs`・`ksql-flow-template/dev`（生成物 `dev/scale/out/**` 含む）・my-ksql-jobs の全ジョブ）を機械的に検索しました。

- **`KLIKE` の出現: 0 件**（書込前・後を問わず、そもそも使用していません）
- スケール検証ツールが使うのは JavaScript 評価の `LIKE` のみ（precheck / verify / touch_single のガード）。§1 のご説明どおり語単位マッチ・索引ラグの影響対象外という整理で一致しています
- 定石ジョブ（ゲート → 集計 → UPSERT）は書込が末尾で、§4 の推奨形と同型です

**したがって「1 件でもあれば検査を実装」の条件には該当せず、エンジン側は文書対応のままで賛成します。**

## 2. §6（安く塞ぐ手）への対応 — CI より手前の「AI 規約」で塞ぎました

当方のジョブ SQL の主な書き手は AI（Claude Code）で、生成規約はテンプレートの `CLAUDE.md` に集約しています。そこで lint より安い手として、ジョブ規約に次の 1 行を追加しました（ksql-flow-template と my-ksql-jobs の両方に反映済み）:

> **書込文（INSERT / UPDATE / UPSERT / DELETE）はジョブの最後に置く**。特に `KLIKE`（kintone の like 素通し）を書込文より後の WHERE / ASSERT に置かない — kintone の全文検索索引は書込に対し即時でなく（実測で数秒のラグ）、取りこぼし・旧値ヒットが起きる。`=` / `IN` / `$id` の条件は影響なし

CI lint（「最初の mutation 以降に `KLIKE` を置かない」）は、資産 0 件の現状では見送ります。AI 規約で生成段階から出ない形にし、将来 `KLIKE` を使うジョブが現れた時点で pr-check workflow（validate-all + dry-run コメント）に grep 1 行を足す、という順で構えます。

## 3. 御礼

`=` / `IN` / `$id` 押し下げが即時（8/8）で **F-7 に影響しない**ことまで確認いただいた点、UPSERT キー照合の信頼性に直結する情報で助かりました。B175 の実測表（DELETE は即時に索引から消える・非対象フィールド更新は影響なし、を含む）は、いずれ連載の設計深掘り記事で引用させてください。
