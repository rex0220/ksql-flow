# 検証記録レビュー（Claude Code / Phase 0 part 1 — 実機検証前半）

- レビュー日: 2026-08-22
- 対象: phase0-part1（`docs/release_verification_v0_1_0.md`・`verification/`・`src/cli.ts` 修正・`.gitignore`）
- 根拠: `docs/phase0_verification_task.md` ／ `docs/release_checklist_v0_1_0.md` Phase 0
- 指摘集計: BLOCKER 0 件 / MAJOR 0 件 / MINOR 0 件

## 検証結果（すべて実行して確認）

1. **§1 秘密退避の独立確認（レビューの最重要項目）**:
   - 退避自体はレビュー担当が Codex 起動前に先行実施（`%USERPROFILE%\.ksql-flow-dev\` へ移動・`dev.env` 生成・`docs/test-app/` 削除。値は一切画面出力せず）
   - `git log --all` に test-app の痕跡なし・インデックス未追跡・**全コミット履歴への実ホスト + トークン 4 本の grep = 0 件**（トークン再発行不要）
   - **リポジトリ全ファイルへの実値混入の機械 grep（独立再実行）= 0 件**。検証記録・schema-notes の cybozu 表記は `<dev>.cybozu.com` / `example` のみ
2. `npx jest`: 9 suites / 100 tests 全通過・`npm run build` 成功（検証ファイル追加による回帰なし）
3. **実機でのみ発現した不具合 1 件の検出と修正を確認**: Windows + Node v24 で CLI 終了時に libuv assertion が発生 → `process.exit(code)` を `process.exitCode = code` の自然終了へ変更（`src/cli.ts`）。保留中 I/O を断ち切らない正しい修正で、タイマーは全て unref 済みのため自然終了を妨げない。実 kintone への validate 直接起動で Exit 0 を再確認済み — 本検証の狙いどおりの成果
4. 検証ジョブの品質: `02_aggregate_deals.sql` は指示書要件（ヘッダ・ASSERT・TEMP TABLE・EXIT SUCCESS IF・`@` 付き時刻関数・KEY）を満たし、かつ **`KSQL-FLOW-TEST-` プレフィックスで対象を限定**して既存実データを集計・更新対象から外す設計 — 実環境安全規約に適合
5. 実機実測の妥当性: UPSERT キー `会社名` の重複禁止有効を validate で確認（KSQL1301〜1303 なし）・API トークンでの `init-logapp` が想定どおり Exit 1（ガードの実機確認）・seed 前 dry-run が NO_DATA / 書込予定 0 / **4 アプリの前後レコード件数不変**（ミューテーション 0 の実機確認）
6. 安全規約の遵守: 本実行・書込なし（読み取り + dry-run のみ）・`maxApiCalls 2000` 設定・`dev.env` 無変更・エンジンリポジトリ無変更

## 総合判定

**part 1 通過。** チェックリスト対応: 0-2 は「ガード実測 + 依頼文作成」まで（ログアプリ生成は Takashi さん待ち）、0-3 は validate / dry-run まで、0-7 は前半記録完成。残項目（0-2 完了・0-3 run 以降・0-4 全部・0-5/0-6）は `docs/release_verification_v0_1_0.md` の TODO と依頼手順書のとおり。Takashi さんの 3 依頼（password 認証 or init-logapp 代行 / ログアプリトークン発行 / 後半の 0-5・0-6）への対応後、part 2 を実施する。
