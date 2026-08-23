# 実装指示: ログアプリへの `deleted_count`（削除件数）追加とラベル改称

- 日付: 2026-08-23 ／ 指示: Claude Code（レビュー担当）／ 実装: Codex ／ 発案: Takashi
- 背景: スケール検証で DELETE の削除行数が `written_count`（ラベル「更新件数」）に合算されるのみで、削除量をログアプリ単体で判別できない。仕様書 8.2 は定義を実装に合わせて修正済み（b72abc4）
- 対象バージョン: v0.3.0 予定（スキーマ加法 = minor）

## 要件

1. **ログアプリ定義**（`src/logapp.ts` の LOG_APP_FIELDS 相当）:
   - `deleted_count`（NUMBER・ラベル「削除件数」）を追加
   - `written_count` のラベルを「更新件数」→「**書込件数**」に変更（フィールドコードは不変）
2. **集計**（`src/executor.ts` / run-all 経路）:
   - `deletedCount` を独立に集計（DELETE の deletedCount の合算。UPSERT/INSERT/UPDATE は 0）
   - `written_count` は**従来どおり全書込の合算（削除を含む）** — 意味を変えない（過去レコードとの連続性維持）
   - JOB / BATCH レコードの書込ペイロードに `deleted_count` を追加。dry-run の挙動は不変（ログ非書込のまま）
3. **後方互換（最重要）**: 旧テンプレート製ログアプリには `deleted_count` が存在しない
   - ランナーは**ログアプリへの初回書込前に 1 回だけ** `app/form/fields` を取得し（この 1 回は maxApiCalls の対象に含める）、`deleted_count` の存在を判定して**存在する場合のみペイロードに含める**
   - 不在の場合は動作継続（エラーにしない）。1 回だけ「ログアプリに deleted_count がありません（テンプレート v0.3 で追加。任意）」程度の情報行を出力
   - 判定結果は実行（プロセス）内でキャッシュし、追加の API を発生させない
4. **`validate --check-logapp`**:
   - `deleted_count` は**任意フィールド**として検査 — 存在すれば型（NUMBER）を検査、不在なら NG にせず「任意フィールド deleted_count が未追加」の案内を出す（Exit 0 のまま）
   - `written_count` のラベルは検査対象外のまま（従来からラベルは検査していない仕様を維持）
5. **文書**:
   - 仕様書 8.2 の表に `deleted_count` 行を追加し、`written_count` の行に「内訳の削除分は deleted_count にも記録（v0.3.0+・フィールドは任意）」を追記。8.2 のラベル表記も「書込件数」へ
   - `template/README.md` に「v0.3.0 で deleted_count（任意）が追加。既存アプリは数値フィールド `deleted_count` を手で追加すれば記録される」を追記
   - README の実行ログ説明・CHANGELOG（Unreleased または 0.3.0 節）
   - **テンプレート zip の再作成は本タスクの対象外**（kintone 画面作業のため Takashi が実施。zip 更新までは「テンプレートは旧版・フィールド追加は手動」の状態で整合するよう文書を書く）
6. **テスト**:
   - deleted_count **あり**のモックログアプリ: DELETE 実行後に deleted_count が正しく記録され、written_count は合算のまま／UPSERT のみのジョブでは deleted_count=0
   - deleted_count **なし**のモックログアプリ: ログ書込がエラーにならず、ペイロードに deleted_count が含まれない（後方互換）／form 取得が 1 回だけであること
   - check-logapp: あり → OK、なし → OK + 案内行
   - 既存 155+ テストを含め全テスト green

## 制約

- 公開契約（config スキーマ・Exit Code・`--json` formatVersion・JSONL envelope）は変更しない
- テンプレート契約テスト（template_contract）が旧 zip のままで green であること（deleted_count を必須にしない）
- エンジンリポジトリ・node_modules に触れない
- 実装後、このファイル末尾に「実装報告」（変更ファイル・設計判断・検証結果）を追記。git commit はしない

## 実装報告

- 実装日: 2026-08-23
- 変更ファイル:
  - 実装: `src/logapp.ts`, `src/runner.ts`, `src/executor.ts`, `src/types.ts`, `src/commands/runAll.ts`, `src/commands/initLogapp.ts`
  - テスト: `test/helpers/world.ts`, `test/__tests__/run.test.ts`, `test/__tests__/runAll.test.ts`, `test/__tests__/dryrun_logapp.test.ts`, `test/__tests__/template_contract.test.ts`, `test/__tests__/limits_secrets.test.ts`
  - 文書: `docs/ksql_flow_spec.md`, `README.md`, `template/README.md`, `CHANGELOG.md`
- 設計判断:
  - `written_count` は従来どおり INSERT / UPDATE / UPSERT / DELETE の全書込件数とし、`deletedCount` を `JobOutcome` に独立追加して JOB / BATCH の `deleted_count` へ集約した。失敗文で一部チャンクだけ成功した場合にも、DML 結果と `onChunkWritten` の実績の大きい方を採用する既存方針を削除件数にも適用した。
  - `LogAppClient` は初回書込直前に `getFields` を呼び、判定 Promise をプロセス内でキャッシュする。旧ログアプリでは全書込経路（ロック、チェックポイント、終了更新、SKIPPED、再送）から `deleted_count` を除外し、案内を 1 回だけ出す。取得失敗も同じ Promise に保持するため追加 API は発生しない。この取得は既存の共有 HTTP 層を通り `maxApiCalls` に含まれる。
  - `deleted_count` は `LOG_APP_FIELDS` に含めて `init-logapp` の新規アプリへ追加する一方、任意フィールド集合として `--check-logapp` と旧 template zip の契約検査では不在を許容した。存在時の型不一致は NG とする。
  - template zip 自体は指示どおり変更せず、v0.3.0 の任意フィールドを手動追加する移行手順を文書化した。
- 検証結果:
  - `npx tsc -p tsconfig.json --noEmit`: PASS
  - 関連テスト: 4 suites / 59 tests PASS
  - `npx jest`: 14 suites / 160 tests PASS（全テスト green、2026-08-23）
  - `git diff --check`: PASS
- git commit: 未実施
