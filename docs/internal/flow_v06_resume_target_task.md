# v0.6 起票: --resume の対象明示指定と実行ホスト表示名 — リラン指示ポーラーの正当性のため

起票: 2026-08-28（Claude Code・オーナー承認済み） / 実装: Codex / 優先度: 高（リラン指示ポーラーの GCP 展開のブロッカー）

## 背景（発見経緯）

リラン指示ポーラー（my-ksql-jobs）の GCP 展開仕様の Codex レビューで、**既存 VPS 運用にも潜在する設計欠陥**が確定した:

1. **`--resume` はチェックされたレコードと結び付いていない。** `findLatestBatch(profile)` は profile のみで最新 BATCH を選ぶ（`src/logapp.ts:300`）。ポーラーは特定の失敗 BATCH レコードへのチェックを契機にリランするが、その BATCH より新しい BATCH が存在すると**別のバッチを resume** する。最新バッチが SUCCESS 済みの場合は「再実行が必要なジョブはありません」で **EXIT.OK (0)** となり（`src/commands/runAll.ts:110`）、ポーラーはチェックされた古い失敗レコードを**誤って `rerun_state = SUCCESS`** にする。
2. **実行ホストの識別子が運用に耐えない。** ログアプリの host は `os.hostname()` 固定（`src/executor.ts:127` ほか）。Cloud Run コンテナでは `localhost` と記録され（2026-08-28 実測）、複数の実行基盤・プロジェクト・ローカル実行を区別できない。ポーラーは `profile + host` で担当を分けるため、識別子の衝突は担当境界の崩壊につながる。

## 要求

### F-A: `--resume-batch <batch_id>`（再開対象の明示指定）

- `run-all` に新フラグ `--resume-batch <batch_id>` を追加する。指定された `batch_id` の BATCH レコードを再開元とし、`--resume` と同じ選抜・as-of 引き継ぎロジックを適用する
- 検証（fail-closed・Exit 1）: 指定 batch_id の BATCH レコードが **0 件または複数件** / profile が実行時 profile と不一致 / `--resume` と `--resume-batch` の併用
- **ログアプリ必須（レビュー指摘反映）**: `--resume-batch` は再開元の解決にログアプリのみを使う。既存 `--resume` が持つ profile 別 state（state.json）へのフォールバックは**適用しない** — 明示指定した対象と無関係なローカル state を再開する危険があるため。ログアプリの GET 失敗・不正応答はフォールバックせず fail-closed（既存の Exit 体系に従い、ログアプリ到達不能系の Exit Code）
- JOB レコードの取得は指定 BATCH 配下（parent_batch_id 一致）のみ
- 指定バッチの全ジョブが SUCCESS 済みの場合の挙動は既存 `--resume` と同一（「再実行が必要なジョブはありません」Exit 0）でよい — 対象が明示されていれば誤 SUCCESS ではなく正しい報告になる
- 既存 `--resume`（最新バッチ）の挙動は不変更（後方互換）

### F-B: 実行ホスト表示名の上書き（環境変数 `KSQL_HOST_LABEL`）

- 設定されている場合、**ログアプリへ記録する host**（BATCH / JOB レコード）に `os.hostname()` の代わりにこの値を使う
- 検証: 1〜64 文字・使用可能文字は `[A-Za-z0-9._:-]`（不正なら Exit 1・fail-closed）
- **重要（罠）**: ローカルロックファイルの host（`src/lock.ts:31`）と同一ホスト生存判定（`src/lock.ts:97` の `content.host === os.hostname()` 比較）は**実ホスト名のまま変更しない**こと。ラベルを混ぜると「同一ホストで PID 生存中は回収しない」保証（仕様 §5.5-1・記事 #11 の防壁）が壊れる。ラベルはあくまでログアプリの表示・検索用の識別子
- 推奨値の例（ドキュメント記載用）: `gcp:ksql-flow-demo` / `vps:vm-xxxx` のような**短い基盤:環境名**（オーナー方針: 一覧・通知で読める長さ。region やジョブ名まで詰め込まない）。未設定なら従来どおり `os.hostname()`

## 利用側（参考・my-ksql-jobs 側で対応）

- ポーラーは claim した BATCH の `batch_id` を `--resume-batch` に渡すことで「チェックした対象をリランする」を厳密化する（それまでの暫定ガードは仕様 v3 参照: チェック対象が profile+host の最新 BATCH でなければ CANCELED）
- GCP の各実行基盤に `KSQL_HOST_LABEL` を設定し、`localhost` 記録を解消する

## 受入基準

- [ ] `--resume-batch` で指定バッチのみが再開対象になる（より新しい BATCH が存在しても影響しない）ことのテスト
- [ ] batch_id 0 件・複数件・profile 不一致・`--resume` 併用が Exit 1
- [ ] ログアプリ GET 失敗時に state.json へフォールバックせず fail-closed になる
- [ ] `KSQL_HOST_LABEL` 設定時: ログアプリ host にラベル・ロックファイル host に実ホスト名が記録されることのテスト
- [ ] ラベル設定下でも同一ホスト生存判定（lock.ts）が実ホスト名で機能する
- [ ] 既存テスト全 green・`--resume` の挙動不変更
- [ ] 公開仕様書（ksql_flow_spec.md）の該当節更新・CHANGELOG 記載

## スコープ外

- ポーラー本体の変更（my-ksql-jobs 側で別途）
- `--resume-batch` の run（単一ジョブ）対応 — run-all のみでよい
