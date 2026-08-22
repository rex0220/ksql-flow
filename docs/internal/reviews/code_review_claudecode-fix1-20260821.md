# 修正差分レビュー（Claude Code / fix1 — Codex 修正回答への再レビュー）

- レビュー日: 2026-08-21
- 対象: `docs/reviews/fix_response_codex-20260821.md` の修正差分（ベースライン = git index、13 ファイル +256/-43）
- 元レビュー: `docs/reviews/code_review_codex-M1-M7-20260821.md`（BLOCKER 4 / MAJOR 8）
- 指摘集計（今回）: BLOCKER 0 件 / MAJOR 0 件 / MINOR 2 件

## 検証結果（すべて実行して確認）

1. `npx jest`: **9 suites / 80 tests 全通過**（修正前 64 → 回帰テスト +16）
2. `npm run build`: 成功（tsc 型エラー 0）
3. **元レビューの再現シナリオを独立に再実行**（scratchpad の verify_fixes.js、TypeScript require hook 方式）— 7 シナリオ **ALL PASS**:
   - B1 `logApp` 未設定 → Exit 1・業務書込 0 件（fail-open 解消）
   - B2 生存 PID + batchTimeoutSec 超過 → 奪取されず（`acquired=false`・所有 batchId 不変）
   - B3 force-unlock 後の旧所有者 `release()` → 新所有者のロックが残存（owner="B"）
   - B4 未解決 `env:`（notifications）→ `ConfigError`
   - M5 ロック INSERT の一般 400 → `LockUnavailableError`（Exit 3）
   - M6 JOB 0 件の RUNNING バッチへの `--resume` → ジョブが再実行される
   - M9 Webhook HTTP 500 → マスク済み警告 1 件（レスポンス本文はログに出ない）
4. 観点 E: `src/` のエンジン import は `@rex0220/kintone-sql-tools/flow` のみ（内部パスなし）。`../kintone-sql-tools` は無変更（`git status` clean）。新規依存パッケージなし。
5. 観点 B（秘密情報）: 指摘 9 の修正は HTTP status のみをエラーメッセージに載せる実装で、URL・レスポンス本文を含まないことを差分とテストで確認。

## 指摘別の判定

| 元指摘 | 判定 | 根拠 |
| --- | --- | --- |
| 1 logApp fail-open | **解消** | run/run-all とも実行前に Exit 1。`--lock local-only` 明示時のみ警告付き続行。dry-run は対象外（DML なし）で妥当 |
| 2 生存 PID の stale 誤回収 | **解消** | `isStale()` が PID 生存確認成功で即 false。回収経路は PID 死亡 or 別ホスト時間超過のみ |
| 3 force-unlock 所有権 | **解消** | `release()` が取得時 batchId と照合し自ロックのみ削除 |
| 4 env: 未解決の無言スキップ | **解消** | notifications / proxy とも `resolveEnvRef()` に統一（トークンと同じ ConfigError） |
| 5 400 の誤分類 | **解消** | 400 → 再 GET で job_key 競合を確認できた場合のみ Exit 5、他は fail-closed Exit 3。エンジンのエラー詳細非公開に依存しない方式で堅牢 |
| 6 JOB 0 件の resume | **解消** | ログアプリ経路も state.json と同じ「未記録 = 未着手 = 再実行」に統一 |
| 8 clientCert/proxy | **解消** | config 読込時 + `createRunnerEnv()` の二重防御で Exit 1。README 更新済み |
| 9 Webhook 非 2xx | **解消** | `response.ok` 検査 + マスク済み警告。ジョブ結果へは非影響（方針維持） |
| 10 境界値テスト | **解消** | 0/1/100/101 件（HTTP 書込回数 `ceil(N/100)` と written_count）、20 文成功 / 21 文 Exit 1 をエンジン実体の結合テストで検証 |
| 7 / 11 / 12 | **据え置き（正）** | 指示どおり裁定待ちのため挙動変更なし |

## 新規指摘（MINOR のみ・今回の通過は妨げない）

### 指摘 F1: `LocalLock.release()` の read → unlink 間に競合窓が残る

- 重大度: MINOR ／ 観点: B ／ 該当: `src/lock.ts:65-71`
- 内容: 所有権確認（read）と削除（unlink）が原子的でないため、その間に第三者が force-unlock → 再取得すると理論上は新ロックを消し得る。同一ホスト・ミリ秒級の窓であり、force-unlock は手動操作のため実害はほぼない。
- 期待値: 将来の改善候補として記録（Windows で確実な原子的解決手段がないため、現状容認が妥当）。

### 指摘 F2: 指摘 6 の修正により `--only` / `--from` バッチ直後の `--resume` が全ジョブ再実行になる

- 重大度: MINOR（裁定候補） ／ 観点: A ／ 該当: `src/commands/runAll.ts:503-506`
- 内容: `--only` / `--from` の run-all は選抜外ジョブの JOB レコードを残さないため、「直近バッチに無い = 未着手 = 再実行」の新規則では、直後の `--resume` が選抜外ジョブを全て再実行し、かつ as-of はその `--only` バッチのものを引き継ぐ。クラッシュ復旧（指摘 6 の本題）とのトレードオフ。
- 期待値: 仕様裁定（下記 6 項）。冪等設計が前提のため安全側だが、意図しない大量再実行になり得る旨をドキュメントに明記するか、選抜外ジョブに SKIPPED（理由 filtered）レコードを残す方式を検討。

## 裁定が必要な項目（累積）

1. NO_DATA と heartbeat（元指摘 11 / 実装報告 Q-1）
2. 依存停止伝播の集合に TIMEOUT / 失敗起因 SKIPPED を含めるか（元指摘 12 / Q-2)
3. チェックポイント縮退（`last_written_key=chunk:<n>`・25 チャンク/60 秒間隔）の MVP 容認（元指摘 7 / E-1）
4. リトライ対象 5xx の範囲（500/502/503/520 列挙 vs 5xx 全般）
5. 単発 run のログ親子構成（Q-3）
6. **（新規）** `--resume` の選抜規則: 直近バッチに JOB レコードが無いジョブの扱い（F2。未着手扱いで再実行 vs 記録があるもののみ）

## 総合判定

**通過。** 元レビューの BLOCKER 4 件・修正対象 MAJOR 5 件はすべて解消を実証した。新規指摘は MINOR 2 件のみで通過を妨げない。裁定待ち 6 項目は Takashi の裁定後に `docs/reviews/decisions.md` へ記録し、該当実装・テスト・ドキュメントを一括更新すること。
