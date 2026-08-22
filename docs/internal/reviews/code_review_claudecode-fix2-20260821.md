# 修正差分レビュー（Claude Code / fix2 — 裁定 Q1〜Q6 反映の再レビュー）

- レビュー日: 2026-08-21
- 対象: fix2 差分（`docs/reviews/fix_response_codex-20260821.md` の fix2 節。8 ファイル +227/-13）
- 根拠: `docs/reviews/decisions.md`（裁定 Q1〜Q6）／ 仕様の正: `docs/ksql_flow_design_v2_6.md`
- 指摘集計: BLOCKER 0 件 / MAJOR 0 件 / MINOR 0 件

## 検証結果（すべて実行して確認）

1. `npx jest`: **9 suites / 87 tests 全通過**（fix1 の 80 → 追加 7）
2. `npm run build`: 成功
3. **独立再現シナリオ 3 件 — ALL PASS**（scratchpad の verify_fix2.js）:
   - **R3-1** `--only 02_b.sql` 実行: 選抜外 2 ジョブに `SKIPPED (filtered)` レコード（**job_key はいずれも空** = 条件(a)）・対象ジョブ SUCCESS・Exit 0・**onFailure 通知 0 件**（= 条件(b) 通知中立）。直後の `--resume` は **JOB レコード追加 0 件・Exit 0**（filtered を再実行しない）
   - **R3-2** filtered レコードとクラッシュ未着手の共存: filtered（01_a）は再実行せず、レコード不在の 02_b **のみ**再実行 — fix1 の「不在 = 未着手」不変条件と両立
   - **R1** 依存元がロック競合で `SKIPPED (LOCKED)` → 依存先 `SKIPPED (dependency)`・集約 **Exit 5**（裁定 Q2 ホワイトリストの LOCKED 経路を実証）
4. 観点 E: `RETRYABLE_STATUS` は列挙方式維持で 504 / 522 / 524 追加のみ。エンジン import は `/flow` のみ・`../kintone-sql-tools` 無変更・新規依存なし。

## 裁定条件との照合

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| R1 (Q2) | **適合** | `DEPENDENCY_SATISFIED_STATUSES = {SUCCESS, NO_DATA}` のホワイトリスト実装へ書き換え（挙動不変）。LOCKED / TIMEOUT 伝播テスト追加。将来ステータス追加時も安全側に倒れる構造 |
| R2 (Q4) | **適合** | 504 / 522 / 524 追加・501 非対象を実装 + テストで確認（`test.each([504, 522])` / 501 単発） |
| R3 (Q6) | **適合** | (a) filtered は `insertRecord` 経由で job_key 非保持を実証。(b) outcomes / statusByName に加えないことで依存伝播・Exit 集約・通知すべてに中立（構造的に担保）。resume 判別は `listBatchJobs` へ `log_detail` を追加し `SKIPPED (filtered)` 前方一致で除外 — 既存スキーマのまま移行不要という選択理由も妥当。state.json 側も `skipReason` 追加で同一規則 |
| R4 (Q1/Q3/Q5) | **適合** | README に heartbeat（Exit 0 で必ず送信）・2 条件通知レシピ・Q3 期限付き容認を明記。設計書リンクを v2.6 へ更新 |

## 補足（指摘ではなく記録）

* filtered 判定は `log_detail` の前方一致（`SKIPPED (filtered)`）に依存する。`recordSkipped` が書く文字列と一体で公開契約化されるため、この文字列を変更する場合は resume 判定・テストと同時に変更すること（設計書 6.3 に既に記録あり）。
* fix1 レビューの MINOR 2 件のうち F2（--only 後の resume）は本 fix2（Q6）で**解消**。F1（`release()` の理論的競合窓)は容認済みのまま残置。

## 総合判定

**通過。** 裁定 Q1〜Q6 の反映は完了し、新規指摘なし。テスト 87 件・独立再現 3 件すべて通過。これで初回リリース前の全体通しレビューは、裁定済み事項を含めて**クローズ**とする。残る外部依存はエンジンへの依頼 E-1〜E-6（特に E-1 解消時の Q3 差し替えと E-2 の dry-run 差分プレビュー）。
