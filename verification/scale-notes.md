# スケール検証 一次記録（scale-notes）

- 企画: `docs/internal/scale_verification_plan.md`（R2）
- 記録規約: 実測は必ずここが一次。記事はここから転記する。実ドメイン・トークンは書かない
- **検証全体の固定 as-of: `2026-08-23T00:00:00+09:00`**（seed の日付・全実行・突合・リランで同一値を明示指定）

## 記録スキーマ（各実測はこの形で追記する）

```
### <段階>-<試験名> (<日付>)
- コマンド: <実行コマンド全文>
- batch_id: <ログアプリの値> / スクショ: <ファイル名 or 撮影なし>
- 計測: 1 回目 <秒> / 2 回目 <秒> / 3 回目 <秒> → 中央値 <秒>（ウォームアップ除く）
- 結果: exit <code> / 読取 <n> 件 / 書込 <n> 件 / API <n> 回（アプリ別内訳: 案件 <n> / 顧客 <n> / ログ <n>）
- 最大 RSS: <MB> / 特記事項:
```

## 環境記録（実機実施時に確定させる）

| 項目 | 値 |
| --- | --- |
| kSQL Flow | v0.2.0 |
| kintone-sql-tools | v3.72.0 |
| Node.js | （実機で記録） |
| OS / CPU / メモリ | （実機で記録） |
| 回線 | （実機で記録） |
| ジョブ・ツールの commit | （実機実施時の ksql-flow-template の commit hash） |

---

## 2026-08-23 モック E2E（実機前の手順検証・参考値）

ツール一式（ksql-flow-template `dev/scale/`）を MockKintone + 実エンジン v3.72.0 で全段階検証。
**モック値であり記事の「実測」には使わない**（API 回数はモックでも実挙動どおり計上される）。

- 全段階の試験項目（12 項目 × S/M/L）: **ALL GREEN**
  1. 集計ジョブ dry-run / 2. 本実行 / 3. **実データ不可侵**（当月の非テスト案件・顧客が不変） / 4. 突合合格 / 5. 突合の検出力（値破壊 → ABORTED） / 6. 同（会社欠落 → ABORTED） / 7. 復元確認 / 8. 書込大ジョブ / 9. touch 対象の限定 / 10. cleanup / 11. 完全削除 / 12. cleanup 再実行安全
- **L-9 ケース①（既定上限）**: 20,000 件読取が dry-run 段階で明示エラー安全停止（exit 1）
  `安全停止: 集計の正しい結果には完全な候補集合が必要です。complete input reason: GROUP_BY, AGGREGATE。取得件数が上限（10000 件）を超えました。WHERE 句で絞り込むか、maxRecords を引き上げてください。`
- **L-9 ケース②**: `maxReadRows: 25000` + `maxTempRows: 25000` で全工程完走（実行時間: モック全 12 工程で 13 秒）

### モック実測の API 回数（実機見積りの参考。ログ・ロック込み）

| 工程 | S | M | L |
| --- | --- | --- | --- |
| 集計 本実行 | 9 | 17 | 107 |
| 突合 verify | 11 | 26 | **147** |
| 書込大 touch | 6 | 28 | 259 |
| cleanup | 9 | 32 | 292 |

- **企画 §5 への補正**: 突合（verify）の見積 45 回は過小 — ASSERT のスカラーサブクエリごとに全件読取が走るため L で約 150 回。L 1 サイクルの予算を約 900〜1,000 回に補正（リラン込み日次 2,000 以内は維持）
- 発見・修正: MockKintone のクエリ解析が `limit N offset M` の後置 offset で limit を失う不具合（500 件超のページングで全件返し）。ksql-flow 側 test helper を修正済み — **実機には存在しないモック限定の不具合**

## 実機記録（ここから下に追記していく）

### SMOKE-1 回目（2026-08-23 昼・**不合格 → 対処済み**）

- 実行: my-ksql-jobs の Claude Code セッション（詳報: my-ksql-jobs `docs/scale_smoke_report.md`）
- seed（CLI IMPORT）: **exit 0・3.6 秒**（顧客 1 INSERT + 案件 10 INSERT — IMPORT の疎通・capability gate・カンマ結合トークン併送・config 互換すべて成立）
- 集計: SUCCESS（読取 14 / 書込 1 / API 9）
- 突合: **ABORTED（exit 2）** — 原因はロジックではなく**環境残存**（Phase 0 の CUSTOMER-001 + DEAL 260 件、記事 #2 の 山田商事/鈴木建設 + 案件A/B/C が名前空間に残存）。ASSERT が環境異常を正しく検出した実例
- 対処（恒久）: **precheck.sql（seed 前の残存 0 件チェック）を生成器に追加**・手順の先頭に組込み（モック 3 ケース検証済み）。一過性の残存は `cleanup_legacy.sql` で一掃（Takashi 承認）
- 収穫（改善候補）: ①ランナーのコンソール出力に経過時間がない（ログアプリ duration_sec はあるが一次記録に不便 — POST 系候補）②auto 権限モードでは書込 CLI が止まるため、検証セッションは settings.local.json の許可ルールを事前準備（レポート運用メモ参照）

### SMOKE-2 回目（再実行待ち — cleanup_legacy → cleanup_1 → precheck → seed から）
