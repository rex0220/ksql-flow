# 検証記録レビュー（Claude Code / Phase 0 part 2 — 実機検証後半）

- レビュー日: 2026-08-22
- 対象: phase0-part2（`docs/release_verification_v0_1_0.md` 完成版・`src/logapp.ts` 修正・`verification/` 追加資材）
- 指摘集計: BLOCKER 0 件 / MAJOR 0 件 / MINOR 0 件（記録事項 2 件）

## 検証結果（すべて実行して確認）

1. `npx jest`: 9 suites / **101 tests 全通過**（100 → +1。DROP_DOWN クエリの回帰テスト差し替え含む）・`npm run build` 成功
2. **最終秘密スキャン（独立再実行）**: `dev.env` の実ホスト + 全トークン値についてリポジトリ全ファイル grep = **0 件**。検証記録の転記方針（ステータス・件数・API 回数のみ、業務値・URL 非転記）が遵守されている — §11 の Webhook 手順も URL を `Read-Host` で受けて記録に残さない設計
3. **実機でのみ発覚した不具合 2 件目の検出と修正を確認**: 実 kintone は DROP_DOWN フィールドへの `=` 演算子を拒否する（kintone クエリ仕様では `in` / `not in` のみ）。`src/logapp.ts` の 3 クエリ（`record_type` / `status`）を `in (...)` へ修正 — 差分は最小・エスケープ経路不変・回帰テスト付き。初回 resume が state fallback に落ちた事象の根本原因として妥当で、修正後の実機再測で「ログアプリを正」の resume 成功を確認済み
4. 実測値の妥当性を突合:
   - 0-3: dry-run 予告（INSERT 0 / UPDATE 1 / DELETE 0）= run 実績 written 1・前後件数一致・dry-run 中の mutation / ログ書込 / state 更新すべて 0
   - チャンク: 案件 260 件 INSERT が 100/100/60 の 3 チャンク（+顧客 1）で written_count 261 と整合
   - 0-4: ABORTED(2)・NO_DATA(0)・二重起動(0/5 分岐 + 直後再実行 0)・resume（失敗 JOB のみ・**全レコードの as_of 同一実値**）— すべてログアプリ実値で裏取りされている
   - 安全規約: 書込は 4246/4247/4249 のみ・検証プレフィックス限定・`dev.env` 読取のみ・RUNNING 残留 0・エンジンリポジトリ無変更
5. 二重起動テストの初回ハーネス無効（両子プロセス Exit 1）を隠さず記録し、有効な形で再測定している — 検証記録として誠実

## 記録事項（指摘ではない）

- **R-1（モック忠実度）**: 実 kintone が拒否する DROP_DOWN への `=` を `test/helpers/mockKintone.ts` の評価器は受理していた（レビュー指示書 D 観点「モックが実装と同じ仮定を共有」の実例）。公開後の改善候補として、モック評価器に DROP_DOWN 型フィールドへの `=` 拒否を追加するとこの種の齟齬を CI で検出できる
- **R-2（seed の lookup トークン）**: 案件 INSERT に lookup 参照元（顧客管理）トークンの併送が必要という実機知見が §2 に記録された。README / examples の tokens 説明に「lookup 参照元アプリのトークンも必要になる場合がある」旨を Phase 1（1-5）で反映すると利用者がつまずかない

## 総合判定

**part 2 通過。** チェックリスト 0-2 / 0-3 / 0-4 / 0-7 は完了（✅ 記入済み）。Phase 0 の残りは Takashi さん実施の 0-5（Webhook 実受信）と 0-6（タスクスケジューラ起動）のみで、いずれもコピペ手順が検証記録 §11 / §12 に用意されている。実機検証は計 2 件の実機限定バグ（Node v24 CLI 終了 assertion / DROP_DOWN クエリ演算子）を検出・修正しており、公開ゲートとして十分に機能した。
