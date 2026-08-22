# 修正差分レビュー（Claude Code / fix3 — v3.70.0 対応・Q7・Q3 縮退解除・E-2 回答）

- レビュー日: 2026-08-22
- 対象: fix3 差分（`docs/reviews/fix_response_codex-20260821.md` の fix3 節）
- 根拠: `docs/flow_runner_fix3_task.md` ／ 申し送り v3.70.0 ／ `docs/reviews/decisions.md` Q3・Q7 ／ 設計書 v2.7
- 指摘集計: BLOCKER 0 件 / **MAJOR 1 件** / MINOR 0 件

## 検証結果（すべて実行して確認）

1. `npx jest`: 9 suites / **92 tests 全通過**（87 → 純増 5）。`npm run build`: 成功。
2. **タスク A の判定 (a) を再検証 — 支持する**: fix2 実装は `read_count` を「最後の結果の累積 `fetchedRows`」として読み、`written_count` は DML 結果オブジェクト、`api_calls` は自前 HTTP カウンタ由来で、いずれも metrics の差分計算に依存していなかった（レビュー担当が fix3 着手前に独立に同じ結論に到達済み）。過去ログの訂正不要という判断も正しい。v3.70.0 スナップショット前提の文単位差分（`metricsDelta`）と「共有参照実装へ戻すと検出する」回帰テストの設計も妥当。
3. **Q7「ウォーターマーク利用なし」を確認**: `lastWrittenKey` / `last_written_key` の参照は記録系（JSONL・ログアプリ・outcome）のみで、resume・依存判定・スキップ等の制御フローから一切読まれていない（grep + resolveResume 読解で確認）。
4. **独立再現シナリオ**（verify_fix3.js）:
   - C-1 250 件 UPSERT: チャンク `[100, 100, 50]`・キー値 `C099/C199/C249` が JSONL に毎チャンク記録・ログアプリ `last_written_key = C249`・`written_count = 250` — **PASS**
   - C-2 3 チャンク目を非リトライ 400 で失敗: `FAILED` (Exit 3)・最後に成功したチャンクの `C199` と `written_count = 200` が残る — **PASS**（初回検証で 500 注入がリトライで回復したのは仕様どおりの正常挙動）
   - C-3 maskFields 伏字化: **FAIL — 下記指摘 1**
5. 観点 E: エンジンリポジトリへの変更は許可された E-2 回答文書 1 ファイルの新規追加のみ（`git status` で確認）。両コピーはバイト一致。新規使用 API（`isDmlResult` / `FlowDmlResult` / `FlowChunkWrittenInfo` / `onChunkWritten` / `explainScript` の `asOf`）はすべて v3.70.0 公開契約。
6. 設計書 v2.7: §5.1 / §8.2 の Q7 再定義・付録 C・CLAUDE.md / AGENTS.md の参照更新を diff で確認 — 裁定文言と一致。
7. E-2 回答文書: 質問 5 件全回答・ランナー要件（10.2 写像 / §7.2 単一カウンタ / TEMP TABLE 前提の振り分け方式 / DELETE 対象 / 5 件・上限 50）を根拠として明記。R1 の `previewStatement` 戻り値型の曖昧さ（非 DML 受理と `Promise<PreviewResult>` の矛盾）を検出し「DML 専用」を推奨案として提示 — 品質良好。

## 指摘 1: `UPSERT ... SELECT` 形式で `lastKeyValue` の maskFields 伏字化が迂回される

- 重大度: **MAJOR** ／ 観点: B（設計書 8.4 `logging.maskFields`）
- 該当: `src/executor.ts:400-405`（`maskLastKeyValue`）
- 内容: AST の UPSERT には `type: "UPSERT"`（VALUES 形式）と `type: "UPSERT_SELECT"`（SELECT 形式）の 2 タイプがあるが、判定が `statement?.type !== "UPSERT"` のみのため、**最も一般的な `UPSERT ... SELECT ... KEY(k)` 形式ではキー列の maskFields 照合が行われず、生のキー値が JSONL とログアプリに記録される**。`SecretMasker`（既知秘密）は通るが、`maskFields` によるフィールド値伏字化（8.4）が黙って無効になる。
- 再現/確認手順: `maskFields: ["顧客コード"]` を設定し 120 件の `UPSERT ... SELECT` を実行 → JSONL の `write_chunk.lastKeyValue` とログアプリ `last_written_key` に `C099` / `C119` が**生値で記録された**（期待: `***`）。既存テスト（run.test.ts「lastKeyValue は logging.maskFields …」）は `upsertValuesJob`（VALUES 形式 = type "UPSERT"）のみを使っていたため検出できなかった。
- 期待値: `UPSERT_SELECT` でも `keyFields`（AST 上は両タイプとも `keyFields: string[]` を持つ）で maskFields 照合を行うこと。回帰テストは **SELECT 形式**で伏字化を検証すること（VALUES 形式のテストは残してよい）。

## 総合判定

~~差し戻し（MAJOR 1 件）。~~ → **通過（差し戻し対応確認済み・2026-08-22）。**

指摘 1 は同日中に修正された: `maskLastKeyValue` が `UPSERT` / `UPSERT_SELECT` 両タイプで `keyFields` の maskFields 照合を行う形に修正され、SELECT 形式の回帰テストが追加された（テスト 92 → 93 件全通過・ビルド成功）。レビュー担当の独立シナリオ C-3（`UPSERT ... SELECT` + `maskFields: ["顧客コード"]`）でも JSONL・ログアプリの双方で `***` への伏字化を再実証した。C-1 / C-2 / C-3 すべて PASS。fix3 はこれでクローズとする。
