# kSQL Flow ランナー実装 コードレビュー（Codex / M1〜M7 全体通し）

- レビュー日: 2026-08-21
- 対象: `src/`、`test/`、`examples/`
- 仕様の正: `docs/ksql_flow_design_v2_5.md`
- 実行結果: `npm test -- --runInBand` 成功（9 suites / 64 tests）、`npm run build` 成功
- 指摘集計: BLOCKER 4件 / MAJOR 8件 / MINOR 0件

観点 A〜E を全て確認した。公式 API 以外のエンジン内部 import、bulkRequest 前提の実装、テレメトリ依存は検出しなかった。一方、安全性の中核である排他と fail-closed に BLOCKER があるため、現状は通過不可と判定する。

## 指摘 1: `logApp` 未設定でも分散ロックなしで業務 DML を実行する

- 重大度: BLOCKER
- 観点: B
- 該当: `src/runner.ts:65`、`src/executor.ts:125`、`src/commands/run.ts:90` ／ 根拠: 設計書 §5.5-2、§5.5-4、§8.1
- 再現/確認手順: TypeScript require hook で `test/helpers/world.ts` の結合環境を生成し、`world.profile.logApp = undefined`、`lockLocalOnly` 未指定で `runCommand` を実行した。結果は `code=0`、顧客マスタへの書込件数は `1`。ログアプリの分散ロックは作成されなかった。
- 期待値: `--lock local-only` が明示されていない限り、`logApp` 未設定は実行前の設定不備または `LOCK_UNAVAILABLE` として停止し、業務アプリの書き込み系 API は 0 回であること。

## 指摘 2: 同一ホストで生存中のプロセスを経過時間だけで stale 回収する

- 重大度: BLOCKER
- 観点: B
- 該当: `src/lock.ts:92` ／ 根拠: 設計書 §5.5-1
- 再現/確認手順: 一時ディレクトリに `pid=process.pid`、`host=os.hostname()`、`startedAt=10秒前` のロックを作り、`batchTimeoutSec=1` で別の `LocalLock.acquire()` を実行した。生存 PID にもかかわらず結果は `ACQUIRED` となり、ロック所有者が新しい batch ID に置き換わった。既存テスト `test/__tests__/locking.test.ts:105` は生存 PID かつタイムアウト前しか検証していない。
- 期待値: 同一ホストで PID が生存している限り自動回収しないこと。開始時刻による回収は、PID が死亡している場合、または生存確認できない別ホスト側の分散ロック規則に限定すること。

## 指摘 3: `--force-unlock` 後に旧所有者が新所有者のローカルロックを削除できる

- 重大度: BLOCKER
- 観点: B
- 該当: `src/lock.ts:64`、`src/lock.ts:75`、`src/commands/run.ts:55` ／ 根拠: 設計書 §5.5-1、§5.5-5
- 再現/確認手順: `LocalLock A` が取得 → 別インスタンスで `forceRelease()` → `LocalLock B` が取得 → A が `release()`、の順に実行した。B のロック内容が存在する状態から、A の `release()` 後にロックファイルが消えた（`existsAfterARelease=false`）。
- 期待値: `release()` は取得時に記録した batch ID 等で所有権を再確認し、自分が所有するロックだけを削除すること。force-unlock と新規取得が競合しても、新所有者の排他を旧プロセスが解除できないこと。

## 指摘 4: 設定済み `env:` 参照が未解決でも通知・proxy を黙って無効化する

- 重大度: BLOCKER
- 観点: B
- 該当: `src/config.ts:241`、`src/config.ts:417`、`src/config.ts:425` ／ 根拠: 設計書 §9.1、§12、flow_runner_task.md §0.3-3
- 再現/確認手順: アプリトークンだけを設定し、`SLACK_ALERT_WEBHOOK_URL` と `DEADMAN_SWITCH_URL` を未設定にして `examples/ksql.config.json` を `loadConfig()` した。例外は発生せず `loaded=true, notifications={}` となった。proxy も同じ分岐で未定義値を `undefined` にする。通常のアプリ token だけは `test/__tests__/config.test.ts:55` でエラーを検証しており、扱いが不統一である。
- 期待値: config に明記された `env:VAR` が未解決なら `ConfigError`（Exit 1）で API 呼出し前に停止すること。オプションを無効にしたい場合は設定項目自体を省略させ、誤記や secrets 設定漏れを黙って成功扱いにしないこと。

## 指摘 5: ロック INSERT の全 HTTP 400 を多重起動（Exit 5）と誤分類する

- 重大度: MAJOR
- 観点: B
- 該当: `src/logapp.ts:142` ／ 根拠: 設計書 §5.5-2、§5.5-4、§10.3
- 再現/確認手順: `findByJobKey()` は 0 件、`postRecords()` は `status=400`・`CB_VA01 invalid field` を返す偽 client で `acquireLock()` を実行した。重複制約エラーではないのに `LockedError` と分類された。
- 期待値: kintone のエラーコード・詳細から `job_key` の重複制約競合だけを Exit 5 とすること。フィールド不備、必須値不足等の一般 400 は「分散ロックを確立できない」Exit 3 として fail-closed にすること。

## 指摘 6: クラッシュ直後で JOB レコードがないバッチを `--resume` が「再実行不要」と判定する

- 重大度: MAJOR
- 観点: C
- 該当: `src/commands/runAll.ts:86`、`src/commands/runAll.ts:482` ／ 根拠: 設計書 §6.1-1、§6.2
- 再現/確認手順: ログアプリに直近の BATCH レコード（`RUNNING`）だけを置き、JOB レコード 0 件の状態で、1ジョブを持つディレクトリに `runAllCommand(..., { resume: true })` を実行した。結果は `code=0`、業務書込 0 件で、「再実行が必要なジョブはありません」と出力された。
- 期待値: 直近バッチに JOB レコードが存在しないジョブは「未着手」として再実行対象に含めること。少なくとも RUNNING/異常終了バッチで JOB 0 件を成功扱いにしないこと。state.json 側で実装済みの「state に載っていないジョブを追加する」処理と同等にすること。

## 指摘 7: チェックポイントが100件チャンクごとでなく25チャンクごとで、`last_written_key` にキー以外を格納する

- 重大度: MAJOR
- 観点: A
- 該当: `src/executor.ts:22`、`src/executor.ts:167`、`src/executor.ts:285` ／ 根拠: 設計書 §5.1-2、§5.1-4、§8.2
- 再現/確認手順: 机上確認。書込成功フックは各 HTTP チャンクで呼ばれるが、RUNNING レコード更新は `CHECKPOINT_EVERY_CHUNKS = 25` または60秒ごとであり、最大2,500件分の進捗が未反映になり得る。終了時の `last_written_key` は実キーでなく `chunk:<n>`。`test/__tests__/http.test.ts:101` は3件のフック通知だけを確認し、100/101件の分割と各チャンクの永続化を検証していない。
- 期待値: 成功した100件チャンクごとにチェックポイントを永続化し、設計書どおり最後に書き込んだキー値を記録すること。エンジン API 制約でキー値を得られない縮退を許容するかは裁定し、許容されるまでは仕様達成済みと扱わないこと。

## 指摘 8: 初期リリース要件の clientCert / proxy を受理して無視する

- 重大度: MAJOR
- 観点: A
- 該当: `src/runner.ts:40` ／ 根拠: 設計書 §9.1、flow_runner_task.md §0.3-2
- 再現/確認手順: 机上確認。`createRunnerEnv()` は `clientCert` と `proxy` が存在しても警告だけを出し、`engineClientConfig()` に渡さない。README の制限事項には記載されているが、設計書はクライアント証明書を「初期リリースから対応」としている。
- 期待値: 指定された clientCert / proxy を実際の kintone 通信へ適用すること。未対応のままなら設定を受理して直結通信へフォールバックせず、誤った通信経路・認証で実行しないよう Exit 1 で停止すること。

## 指摘 9: Webhook の HTTP 4xx/5xx を成功扱いし、通知不達を検知しない

- 重大度: MAJOR
- 観点: C
- 該当: `src/notify.ts:18` ／ 根拠: 設計書 §7.3
- 再現/確認手順: `notifyFailure()` の `fetchImpl` に HTTP 500 Response を返す関数を注入した。Promise は正常完了し、警告出力は0件だった。`post()` は fetch の例外だけを扱い、`response.ok` を確認していない。
- 期待値: 非2xxを通知失敗として検知し、少なくともマスク済み警告を出すこと。通知失敗をジョブ結果へ反映しない方針は維持してよいが、「通知した」と誤認できる無言成功にしないこと。

## 指摘 10: 必須境界値（1/100/101件・20文ちょうど）のテストがない

- 重大度: MAJOR
- 観点: D
- 該当: `test/__tests__/run.test.ts:102`、`test/__tests__/http.test.ts:101`、`test/__tests__/validate.test.ts:125` ／ 根拠: 設計書 §5.1-4、§11、flow_runner_task.md §6
- 再現/確認手順: `rg -n '100|101|Array.from|records:' test/__tests__ test/helpers/world.ts` で確認。0件・1件相当の業務シナリオと21文エラーはあるが、書込0/1/100/101件のチャンク境界、20文ちょうどの成功を一組として検証するテストがない。実行した64件は全通過したが、この欠落は検出されない。
- 期待値: 0/1/100/101件で HTTP 書込回数、written_count、チェックポイントを検証し、20文は成功・21文は Exit 1 を検証すること。モックの実装詳細だけでなく、エンジン実体を通る結合テストにすること。

## 指摘 11: `NO_DATA` でも heartbeat を送信し、「通知なし」の受け入れテストが不十分

- 重大度: MAJOR
- 観点: A
- 該当: `src/commands/run.ts:118`、`src/notify.ts:81`、`test/__tests__/run.test.ts:102` ／ 根拠: 設計書 §3.2、§8.5、flow_runner_task.md §3・§6-2
- 再現/確認手順: 対象0件、heartbeat設定ありで `runCommand()` を実行した。結果は `NO_DATA` / Exit 0 だが通知 POST は1回だった。既存テストは heartbeat 未設定のため、onFailure が呼ばれないことしか実証していない。
- 期待値: 設計書の「通知しない」が heartbeat を含むなら NO_DATA では一切送信しないこと。dead man's switch として heartbeat を例外扱いするなら、Takashi の裁定後に仕様・受け入れ基準・テストを同時更新すること。

## 指摘 12: TIMEOUT と失敗起因 SKIPPED を依存停止伝播へ追加しているが仕様未裁定

- 重大度: MAJOR
- 観点: A
- 該当: `src/commands/runAll.ts:33`、`src/commands/runAll.ts:225` ／ 根拠: 設計書 §3.3、§4、§7.1
- 再現/確認手順: 机上確認。設計書 §3.3 は依存元が `FAILED` / `ABORTED` の場合「のみ」SKIPPED と明記する一方、実装は `TIMEOUT` と `SKIPPED` も伝播対象にしている。実装完了報告でも Q-2 として裁定待ちのまま。
- 期待値: Takashi の裁定前に仕様達成済みとしないこと。裁定結果に合わせ、伝播集合、SKIPPED理由、run-all集約、resume対象、結合テストを一貫して更新すること。

## 実行したテスト・再現シナリオの一覧

1. `npm test -- --runInBand`
   - 成功。9 test suites / 64 tests、失敗0、snapshot 0。
   - package.json 側も `jest --runInBand` のため、実際の表示は `jest --runInBand --runInBand`。
2. `npm run build`
   - 成功。`tsc -p tsconfig.json` の型エラー0。
3. `npm ls --depth=0`
   - 成功。エンジンはローカル `file:../kintone-sql-tools` の v3.69.0。実行時依存は当該エンジンのみ。
4. import / 通信面の静的確認
   - `src/` のエンジン import はすべて `@rex0220/kintone-sql-tools/flow`。内部パス import、bulkRequest、テレメトリ送信は検出せず。
5. ログアプリ未設定 fail-open
   - `logApp=undefined`、`--lock local-only` なしで Exit 0、業務書込1件を再現。
6. 生存 PID の stale 誤回収
   - 同一ホスト・現 PID・タイムアウト超過ロックを別取得できることを再現。
7. force-unlock 後の所有権競合
   - 旧所有者の release が新所有者のロックを削除することを再現。
8. notification / proxy 系 `env:` 未解決
   - examples config がエラーにならず `notifications={}` でロードされることを再現。
9. 非重複 HTTP 400 のロック分類
   - `CB_VA01 invalid field` が `LockedError` になることを再現。
10. JOB 0件バッチの resume
    - `--resume` が Exit 0・再実行0件になることを再現。
11. Webhook HTTP 500
    - `notifyFailure()` が正常完了し警告0件となることを再現。
12. NO_DATA + heartbeat
    - Exit 0 / NO_DATA で通知 POST 1回を再現。
13. 受け入れ基準の逆引き
    - 基準1: サンプル実行とJOBログあり。
    - 基準2: ABORTED / NO_DATA / onFailure はあり。ただし heartbeat を含む「通知なし」は未達（指摘11）。
    - 基準3: 二重起動、終了時クリア、stale テストあり。ただし生存ロックとforce-unlock競合に欠陥（指摘2・3）。
    - 基準4: 通常のFAILED/SKIPPED resumeとas-of継承あり。ただし未着手クラッシュ復旧に欠陥（指摘6）。
    - 基準5: ログアプリ到達不能と再送あり。ただし logApp 未設定で fail-open（指摘1）。
    - 基準6: Exit集約の優先順位テストあり。
    - 基準7: maxApiCalls とログ・ロック計上テストあり。
    - 基準8: token / password の出力面マスキングテストあり。
    - 基準9: README の使い方・Exit表・互換表あり。

## 裁定が必要な項目

1. **NO_DATA と heartbeat**: 設計書 §3.2 の「通知しない」に heartbeat を含めるか。実装担当報告 Q-1 は heartbeat を例外扱いする案。裁定までは指摘11を未解決とする。
2. **依存停止伝播集合**: 設計書 §3.3 の `FAILED` / `ABORTED` のみに対し、`TIMEOUT` と失敗起因 `SKIPPED` を加えるか。実装担当報告 Q-2。裁定までは指摘12を未解決とする。
3. **チェックポイント縮退**: エンジン E-1 対応前に、`last_written_key=chunk:<n>` と25チャンク/60秒間隔をMVP仕様として許容するか。許容する場合も、設計書 §5.1・§8.2と受け入れテストの明示更新が必要。
4. **リトライ対象の「5xx」範囲**: flow_runner_task.md §4-1 とレビュー指示書 C は 5xx 全般と読める一方、設計書 §7.1 は 500/502/503/520 を列挙し、実装もその列挙のみ。501/504等をリトライするかを明文化する必要がある。
5. **単発 run のログ親子構成**: 実装担当報告 Q-3 のとおり、JOBのみ・`parent_batch_id` 空を正式仕様とするか。設計書 §8.1 は BATCH を run-all 1回につき1件とするが、単発 run の batch_id / parent の契約は明記が薄い。

既存の `docs/reviews/decisions.md` はレビュー時点で存在しなかったため、裁定済み事項との重複除外は発生していない。

## 総合判定（M1〜M7 通過可否）

**通過不可。** BLOCKER が4件ある。特に、ログアプリ未設定時の fail-open、生存プロセスの stale 誤回収、force-unlock 後の所有権崩壊は、業務 DML の多重実行を許し得るためリリースを止める必要がある。

BLOCKER 4件を修正し、指摘5〜12の回帰テストと裁定結果を反映した後、修正差分と該当テストを対象に再レビューする。
