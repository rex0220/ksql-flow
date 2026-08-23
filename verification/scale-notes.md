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
| Node.js | v24.14.0 |
| OS / CPU / メモリ | Windows 11 Pro 10.0.26200（CPU/メモリ・回線は未記録） |
| 回線 | （未記録） |
| ジョブ・ツールの commit | ksql-flow-template `c6ca170`（+ S 実施中の未コミット: seed_run.mjs tier 対応・job_run.mjs 追加） |

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

### SMOKE-2 回目 (2026-08-23 昼・**合格**)

- 実行: my-ksql-jobs の Claude Code セッション（詳報: my-ksql-jobs `docs/scale_smoke_report.md`「SMOKE 2 回目」）
- cleanup_legacy: exit 0・書込 266（案件 263 + 顧客 3 = 1 回目調査の残存数と完全一致）→ cleanup_1（前回 seed 分 11）→ precheck SUCCESS
- 本編: seed exit 0・**1.5 秒**（1+10）→ 集計 SUCCESS（読取 11/書込 1/API 9）→ 突合 SUCCESS（読取 61/API 11）→ cleanup 11 件 → precheck + MCP で残存 0
- 定型確定: **precheck → seed → 集計 → 突合 → cleanup → precheck**。本編 API ≈ 42 回（企画 §5 S 概算内）

### S-集計サイクル (2026-08-23・**合格**)

- コマンド: my-ksql-jobs `docs/scale_s_report.md` に全文（job_run.mjs 計測ラッパー経由・全実行 as-of 固定値明示）
- batch_id: 未記録（ログアプリ未参照） / スクショ: 撮影なし
- 計測（集計 本実行）: 1 回目 1.6 / 2 回目 2.7 / 3 回目 1.4 → **中央値 1.6 秒**（ウォームアップ 2.7 除く）
- 結果: 全回 exit 0 / 読取 220 件 / 書込 20 件 / API 9 回（アプリ別内訳: 未取得 — ログアプリ MCP 参照を M までに整備）
- 最大 RSS: 未計測 / 特記事項:
  - **seed 初回 exit 2**: CLI 既定 `--dml-max-rows 100` < 案件 200 で fail-closed 停止（顧客 20 のみ投入・案件 0 = 部分投入なし）。tier 別上限（S: 1000/500）を seed_run.mjs に追加して再実行 exit 0・4.9 秒。**README の上限フラグ記載が L のみなのは漏れ — S/M も必要**
  - 顧客 UPSERT の冪等を実機確認（再 seed で updated=20）
  - EXPLAIN（MCP ksql_explain）記録・dry-run --json: update 20 / estimatedWrites 1 / **プレフィックス外書込 0** / 差分は本実行と一致
  - 突合 SUCCESS（読取 707/API 11・2.1 秒）— ASSERT ごとの全件再読取傾向はモック E2E と一致（L 予算補正の裏付け）
  - 観点 7: 同一 as-of 再実行 → 書込 20（初回と同値）→ 突合 SUCCESS で最終状態不変
  - 観点 8（境界値・書込 101 件）: `out/S/boundary_touch101.sql` 新設（C1〜C10 の 100 件 + D11-1）。dry-run estimatedWrites **2** → 本実行 SUCCESS 書込 101/API 6・1.8 秒 = **100+1 の 2 リクエスト分割を確認**
  - cleanup: 削除 220（案件 → 顧客順）・API 9・1.8 秒 → precheck + MCP 残存 0
  - サイクル API 合計 ≈ 105 回（計測 3 回 + 再実行 + 境界値込み。単回換算では §5 概算内）
- 進行ゲート: **S 合格 → M 着手可**（M 前に: アプリ別 API 内訳 + RSS 計測の整備を推奨）

### M-集計サイクル (2026-08-23・**合格**)

- コマンド: my-ksql-jobs `docs/scale_m_report.md` に全文（M 前に計測整備: job_run.mjs へ RSS 採取追加・ksql.mcp.config.json に実行ログ APP4249 追加 = 観点 3/5 が充足）
- batch_id: レポート §9 の表（22066d36〜414de124） / スクショ: 撮影なし
- 計測（集計 本実行）: 1 回目 6.0 / 2 回目 3.6 / 3 回目 5.2 → **中央値 5.2 秒**（ウォームアップ 6.5 除く）
- 結果: 全回 exit 0 / 読取 2200 件 / 書込 200 件 / API 17 回（アプリ別内訳: 未取得のまま — L 前にランナー側の内訳出力を検討）
- 最大 RSS: ≈ 78 MB（突合 ≈ 83 MB。S 比ほぼ横ばい） / 特記事項:
  - **seed 初回 exit 1**: CLI `--timeout` 既定 30 秒が 2,000 件 IMPORT に不足。**書込はサーバ側で完了済み（MCP 実測 2,000 件・重複なし・総売上一致）なのにクライアントは TimeoutError** — IMPORT の失敗 exit は「未書込」を意味しない。案件 INSERT は再実行不可のため、失敗時は必ず件数実測 → cleanup → 再 seed（L では手戻り 10 分級・API 260 回なので timeout 引き上げ必須）
  - 対処: seed_run.mjs に tier 別 `--timeout`（M 600s / L 3600s）→ クリーン再 seed exit 0・**55.1 秒**（L の 20,000 件は 10 分級と推定）
  - dry-run: 読取 2,000/10 回（カーソル複数回転 ✓）・update 200 / estimatedWrites 2（チャンク回転 ✓）・プレフィックス外 0
  - 突合 SUCCESS: 読取 6827/API **26** — **モック E2E の 26 と完全一致**（L 予算補正 verify≈147 の信頼度向上）
  - 観点 5: ログアプリの read/written/api_calls/as_of が全ジョブでコンソール実測と完全一致
  - 観点 7: 同一 as-of 再実行 → 書込 200（初回同値）→ 突合 SUCCESS
  - cleanup 2,200 件（案件 → 顧客順）API 32・8.3 秒 → precheck + MCP 残存 0
  - サイクル API ≈ 290（やり直し込み）/ 単回換算 ≈ 130 で §5 概算 140 内
- 進行ゲート: **M 合格 → L 着手可**（L は 1 日 1 サイクル予算・中断試験スクショ「撮り逃し厳禁」のため実施タイミングは Takashi 判断）

### L-集計系 + 書込大 + L-12 (2026-08-23・**実施分すべて合格**)

- コマンド・全出力: my-ksql-jobs `docs/scale_l_report.md`（全実行 as-of 固定値明示・job_run.mjs 計測）
- seed: exit 0・**364.4 秒**（2,000+20,000。M で追加した --timeout 3600s が必須）。総売上 **20,010,110,000** = 全体検算値一致
- **L-9 ①**: 上限未設定 dry-run → 既定 10,000 で明示エラー安全停止（exit 1・書込 0・メッセージはモックと同一）
- **L-9 片方だけ**: maxReadRows 25000 のみ → 集計も明細 TEMP も 10,000 で停止。機序を実装から特定: **CREATE TEMP AS SELECT の実体化フェッチ上限は tempTableMaxRows ?? 10000（maxRecords 非適用）** — 「片方だけでは失敗点が移動」の実機確認
- **L-9 ②**: 両方 25,000 → dry-run 完走（読取 20,000/46 回・API 86 ≒ 見積 85・RSS 118 MB）
- 計測（集計 本実行）: 40.5 / 29.6 / 31.4 → **中央値 31.4 秒**（WU 40.8 除く）。全回 読取 22,000/書込 2,000/**API 107 = モック一致**・RSS ≈ 115 MB
- 突合: SUCCESS・読取 68,036/**API 147 = モック補正値一致**・24.0 秒・**RSS 147 MB（本検証最大）**
- **L-10**: ① 集計は TEMP 出力 2,000 行で影響なし ② 明細 20,000 行実体化 — 片方設定で安全停止 / 両方で完走（44 回・9.9 秒・RSS 91 MB）
- **L-12**（--max-api-calls 70）: **exit 3・API ちょうど 70・書込 50 チャンク途中停止** → ログアプリ **RUNNING のまま・last_written_key=chunk:35**（25 チャンク刻み CP）・ローカル JSONL に logapp_write_failed（pending 退避）→ 同一 as-of 再実行で **RUNNING→FAILED 解消・chunk:35→50 再送反映**・新バッチ SUCCESS（**API 259 = モック一致**・502 秒・CP chunk:200）。Exit 5 にはならず
- cleanup: 22,000 件・**API 292 = モック一致**・105.6 秒 → precheck + MCP 残存 0。config の limits はコミット状態へ復元済み
- L サイクル API ≈ **1,540 回**（日次予算 1,500〜2,000 内）。**429/5xx は全日通して観測ゼロ**（L-13 は「発生せず」を記録）
- 知見: 書込が時間の支配項（UPDATE 200 チャンク 8.4 分 vs DELETE 220 チャンク 1.8 分 ≈ 5 倍/チャンク → F-5 判定材料）。モックの API 予測は 4 工程すべて実機一致 — 今後の予算はモックで確定可
- **残タスク（Takashi 立ち会い）**: L-11 ①②（Ctrl+C 中断 → unlock → リラン / run-all --resume。スクショ素材）・無人運用ゲート 3 点（§4.3）。実施時は再シード（≈6 分）+ config へ limits 追加から

### XL（100,000 件）— 準備完了・実機未実施（2026-08-23 追加）

- 位置づけ: 仕様 11 章の公表目標「読取 10 万 → 書込 1 万・10 分以内」と同スケール（1 万社 × 10 件・総売上検算値 **500,050,550,000**）。F-3 回答 §5 の「10 万段階の実測共有」への回答
- 生成器 XL 対応: touch 3 分割・cleanup 5 分割（文数上限対応の複数ファイル一般化）・timeout 7200・deals.csv 5.99 MiB（IMPORT 10 MiB 制限内）
- **全 11 生成物が runner validate 合格**（構文・文数・スキーマ・dialect 検査）。フルモック E2E は 10 万件でモックのクエリ評価が遅く 10 分超のため断念 — **挙動の証明は L の E2E とモック=実機 API 一致実績で代替**（モック限定の制約であり実機性能とは無関係）
- 実機の前提: limits `maxReadRows/maxTempRows 120,000・batchTimeoutSec 7200`・seed_run が CLI 上限/タイムアウトを自動付与（seed 見込み ≈ 30 分）・**API ≈ 5,000〜5,500/サイクル → 1 日 1 サイクル厳守**
- 注目計測: 集計の所要時間（公表目標 10 分以内の判定）・RSS（L 147 MB → 推定 500〜700 MB・1GB 目安との比較）・IMPORT 6 MiB の実所要
