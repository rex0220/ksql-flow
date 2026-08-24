## 指摘 1: 個別ジョブの LOCKED 経路が表と通知説明に反映されていない
- 重大度: BLOCKER（矛盾）
- 該当箇所: §4.1 の表（「失敗したジョブ」「依存する後続」「独立した後続」「終了コード」）および「通知」（§3.2、§3.3、§8.5、§10.3、`src/commands/runAll.ts:298-300, 323-336, 475-507`）
- 内容: run-all 実行中の個別ロック競合は、実装上そのジョブを `FAILED` 系ではなく `SKIPPED (LOCKED)` として記録し、`stopRequested` は `FAILED` / `ABORTED` / `TIMEOUT` にしか遷移しない。このため `--stop-on-error` 指定時でも、LOCKED ジョブの依存先は `SKIPPED (dependency: <job名>)` になる一方、独立した後続は実行される。§4.1 の `--stop-on-error` 行が示す「以降は依存・独立とも `stop-on-error`」とは一致しない。また、LOCKED と成功が混在した場合、Exit は既定で 5、`--continue-on-error` で 4 になるが、`aggregateStatus` は BATCH を `SUCCESS` にする（全件 LOCKED なら `SKIPPED`）。したがって「失敗があれば BATCH が FAILED 系になり、kintone 条件通知が BATCH の 1 通に集約される」という記述もこの経路では成立しない。
- 提案: §4.1 に個別ロック競合の例外を最小限追記し、「当該 JOB は `SKIPPED (LOCKED)`、依存先は `SKIPPED (dependency: <job名>)`、独立ジョブは `--stop-on-error` 指定時を含め続行、Exit 集約は §10.3、BATCH status は成功混在時 `SUCCESS`・全件該当時 `SKIPPED` であり kintone の FAILED 系条件通知の対象外」と明記する。あわせて表の「失敗したジョブ」は FAILED 系だけを対象とする旨を明示する。

## 指摘 2: 依存スキップ理由の表記が実装および §8.2 の文字列契約と一致しない
- 重大度: MAJOR（誤解を招く）
- 該当箇所: §4.1 の既定行・`--continue-on-error` 行（§8.2、`src/commands/runAll.ts:265-280, 465`）
- 内容: 表は依存スキップをコード表記で `SKIPPED（dependency）` としているが、実際の `log_detail` 先頭は依存元名を含む ASCII の `SKIPPED (dependency: <job名>)` である。§8.2 は `SKIPPED (<理由>)` の前方一致を resume 選抜と Exit 集約の契約にしているため、要約表の表記をそのまま検索・判定文字列として読むと一致しない。`--continue-on-error` 時も理由は同じ `dependency: <job名>` である。
- 提案: 2 セルをともに実際の契約表記 `SKIPPED (dependency: <job名>)` に置き換える。併せて `stop-on-error` / `batch-timeout` も、コード表記する箇所では §8.2 と同じ ASCII 括弧に統一する。
