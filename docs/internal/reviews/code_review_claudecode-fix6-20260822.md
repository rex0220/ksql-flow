# 再レビュー（Claude Code / fix6 + 仕様書修正 — spec レビュー指摘の解消確認）

- レビュー日: 2026-08-22
- 対象: `spec_review_codex-20260822.md` の指摘への対処（文書 8 件 = Claude Code 適用 / 実装 3 件 + README 整合 = Codex fix6）
- 指摘集計: BLOCKER 0 件 / MAJOR 0 件 / MINOR 0 件

## 合格条件 6 項目の検証結果（すべて実行して確認）

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | MAJOR 5 件の解消 | **✓** B-1（冒頭案内の非規範化）/ C-1（--help 迂回）/ C-2（heartbeat always）/ C-4（バイナリ配布を提供予定へ）/ D-1（付録 A 実コマンド化） |
| 2 | spec の残存参照 regex（裁定\|申し送り\|fix\d\|decisions.md\|付録 C\|Q1-7\|PRE-\|POST\|v2.x）| **0 件** |
| 3 | 付録 A の実行例が bin 名 `ksql-flow` と一致 | **✓**（Docker CMD 含む 4 箇所） |
| 4 | `run --help --bogus` / `run --help extra` の Exit 1 回帰 | **✓** CLI 直接実行で独立実証（Exit 1・拒否メッセージ。`run --help` 単独と `--help` 単独は Exit 0） |
| 5 | heartbeat success / always の spec・schema・runtime 三者一致 | **✓** spec §7.3 定義・schema 値域・実装評価 + 両値テスト（ABORTED で always は onFailure と併送）。README の「裁定 Q1」参照も除去（0 件） |
| 6 | test / typecheck / build / pack 再実行 | **✓** 13 suites / **146 tests 全通過**（135 → +11）・typecheck / build / pack dry-run OK |

## MINOR 5 件の解消確認

B-2（POST 課題 → 将来検討）/ C-3（lock path 実体化）/ C-5（JSONL best-effort 契約 + stderr 警告 1 回・秘密非含有テスト付き）/ D-2（実測 TODO 文言除去・切り詰め実装値明記・性能表の未保証格下げ）/ D-3（SKIPPED 定義拡張・7.1 通知欄の統一）— すべて反映確認。

## 総合判定

**通過。リリース版仕様書 `docs/ksql_flow_spec.md` は公開合格。** 凍結対象 `docs/internal/ksql_flow_design_v2_9.md` は無変更（開発時点の記録として保存）であることも確認した。
