# 実装指示: `limits.maxReadRows`（読取候補上限の設定可能化）

- 日付: 2026-08-23 ／ 指示: Claude Code（レビュー担当）／ 実装: Codex
- 背景: F-3 回答（`docs/kSQLエンジンからの回答-20260823-F3-flow読取上限.md`）。エンジン `/flow` の `createExecutionContext` / `explainScript` には v3.69.0 から options `maxRecords`（文単位の読取候補行数上限・既定 10,000）が実装済み。ランナーはこれを設定から渡せるようにする。スケール検証 L 段階（20,000 件）の前提作業

## 要件

1. **config**: `profiles.<p>.limits.maxReadRows` を追加
   - 型: 正の整数。**受理範囲 1〜200,000**。範囲外・非整数は `ConfigError`（実行前 Exit 1。既存の limits 検証と同じ流儀）
   - 既定 `null` = エンジンに渡さない（エンジン既定 10,000 のまま）
   - `DEFAULT_LIMITS` / 型 / パース / unknown-key 検証（既存 assertKnownKeys のリスト）を更新
2. **実行経路**: `src/executor.ts` と `src/commands/dryrun.ts` の `createExecutionContext` options に、`maxReadRows !== null` のとき `maxRecords` を渡す（`tempTableMaxRows` と同じパターン）。他に `createExecutionContext` / `explainScript` を呼ぶ経路があれば同様に（現状 grep では上記 2 箇所のみ）
3. **schema**: `schema/ksql.config.schema.json` に `maxReadRows` を追加（minimum 1 / maximum 200000）
4. **文書**:
   - README の limits 説明（`maxTempRows` の並び）に 1 行追加。**注意書き**: 読取を引き上げる場合は `maxTempRows` も揃えること（片方だけでは一時テーブル実体化で失敗点が移動する — エンジン回答 §3）
   - 公開仕様書 `docs/ksql_flow_spec.md`: 9.x の limits 表に `maxReadRows` を追加。**11 章の「ストリーミング最適化」の段落を「将来検討（現状は単純 GROUP BY も読取候補は maxReadRows の対象。既定 10,000・引き上げは明示設定）」に修正**（現実装と乖離しているため）
   - `examples/ksql.config.example.json` に例（コメント不可の JSON なので値だけ、または省略可）
   - CHANGELOG に追記
5. **テスト**（jest・既存の流儀に合わせる）:
   - config: 受理（1 / 200000）・拒否（0 / 200001 / 小数 / 文字列）・未指定 null
   - 実行経路: MockKintone で 15 件のアプリを用意し、`maxReadRows: 10` で FULL_SCAN 系 SELECT を含むジョブが**エンジンの上限エラーで安全停止**（FAILED・書込ゼロ）すること、`maxReadRows: 100` で完走することの 2 本（`maxRecords` が実際にエンジンへ配線されている証明。下げ方向で検証するのがエンジン回答 §2 と同じ手法）
   - dry-run 経路でも同様に 1 本

## 制約

- 公開契約（fix5）を守る: config の unknown-key 拒否・`--json` formatVersion 変更なし・既存 Exit Code 体系不変
- エンジンリポジトリ・`node_modules` に触れない
- 既存 146 テストを含め全テスト green
- 実装後、変更ファイル一覧と設計判断の要約をこのファイル末尾に「実装報告」として追記すること

## 実装報告

実装日: 2026-08-23

### 変更ファイル

- `src/config.ts`: `LimitsConfig` / `DEFAULT_LIMITS` / unknown-key 検証 / パースへ `maxReadRows` を追加し、1〜200,000 の整数だけを受理
- `src/executor.ts`: 通常実行の `createExecutionContext` へ、非 `null` 時だけ `maxRecords` を設定
- `src/commands/dryrun.ts`: dry-run の `createExecutionContext` へ同じ条件で `maxRecords` を設定
- `schema/ksql.config.schema.json`: `maxReadRows` の integer / null、minimum 1、maximum 200000 を追加
- `README.md`: limits 説明と `maxTempRows` を同規模に揃える注意を追加
- `docs/ksql_flow_spec.md`: 9 章の設定例・limits 表・注意事項を更新し、11 章のストリーミング最適化を現状に即した将来検討へ修正
- `examples/ksql.config.example.json`: `maxReadRows: 200000` の設定例を追加
- `CHANGELOG.md`: 設定可能化を追記
- `test/__tests__/config.test.ts`: 未指定 `null`、境界値 1 / 200000、不正値 0 / 200001 / 小数 / 文字列を追加
- `test/__tests__/maxReadRows.test.ts`: MockKintone 15 件による通常実行の停止 / 完走と dry-run の停止を追加
- `test/__tests__/limits_secrets.test.ts`: 手組み `LimitsConfig` fixture を新しい型へ追従

### 設計判断

- 既存の `maxTempRows` と同じ optional spread を使い、`maxReadRows === null` では `maxRecords` 自体を渡さず、エンジン既定 10,000 を維持した。
- config の上限 200,000 はランナー側で API 呼び出し前に `ConfigError` とし、既存の unknown-key 拒否、Exit Code、dry-run `formatVersion` は変更していない。
- 読取上限超過は既存の SQL 実行エラー分類を維持し、通常実行では `FAILED` / Exit 1、dry-run では `FAILED` / Exit 1 として安全停止する。HTTP / ネットワーク障害向け Exit 3 への分類変更は行っていない。
- 実行経路テストは `SELECT * FROM LAPP_受注` の FULL_SCAN 後に DML を置き、上限 10 ではエンジンの上限エラーで後続書込が 0 件、上限 100 では 15 件を読み取り後続 DML が完走することを確認した。

### 検証結果

- `npx tsc -p tsconfig.json --noEmit`: 成功
- 対象テスト (`config.test.ts`, `maxReadRows.test.ts`): 33 tests green
- `npx jest`: 14 suites / 155 tests green
- エンジンリポジトリ、`node_modules` は変更していない。git commit は作成していない。
