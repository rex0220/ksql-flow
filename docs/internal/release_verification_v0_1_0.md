# kSQL Flow v0.1.0 リリース実機検証記録

- 実施日: 2026-08-22
- 担当: Codex（Phase 0 実機検証）
- 接続先: `https://<dev>.cybozu.com`（実ドメイン・トークンは非記録）
- 環境: Windows NT 10.0.26200.0 / Node.js v24.14.0 / npm 10.2.3
- 安全上限: `limits.maxApiCalls = 2000`
- 記録方針: ステータス、件数、API 回数、時刻だけを転記し、業務レコード値と認証情報は転記しない

## 結果サマリ

| 項目 | 結果 | 要点 |
| --- | --- | --- |
| §1 秘密退避 | PASS | リポジトリ外 `dev.env`、履歴混入 0、最終実値照合 0 |
| §2 dev セットアップ | PASS | env 参照だけの local config、Asia/Tokyo、maxApiCalls 2000 |
| 0-2 ログアプリ | PASS | app 4249、全フィールドと `job_key` 重複禁止を実検査 |
| 0-3 通し検証 | PASS | validate → dry-run mutation 0 → run、予告 UPDATE 1 と実績 1 が一致 |
| 0-4 ASSERT | PASS | ABORTED / Exit 2 / written 0、専用 cleanup で negative 0 |
| 0-4 NO_DATA | PASS | NO_DATA / Exit 0 / written 0 |
| 0-4 二重起動 | PASS | child_process 2 本が Exit 0 / 5、直後再実行 Exit 0 |
| 0-4 resume | PASS | ログアプリを正に失敗 JOB 1 本だけ再実行、元 as-of 一致 |
| 0-4 チャンク | PASS | 260 案件を 100 / 100 / 60 に分割、JSONL と JOB を突合 |
| 0-5 Webhook | PASS | 2026-08-22 Takashi さん実施。ABORTED / Exit 2 で JSON POST 1 回を実受信（§11 の追記参照） |
| 0-6 タスクスケジューラ | PASS | 2026-08-22 Takashi さん実施。LastTaskResult 0・3 ジョブ完走・ログアプリ BATCH と突合一致（§12 の追記参照）。BOM なし UTF-8 の PS 5.1 パースエラーを実機検出し修正 |
| 0-7 記録 | PASS | 本書と fix response を更新 |

Phase 0 の Codex 担当 0-2〜0-4、0-7 は完了。残りは Takashi さん担当の 0-5 / 0-6 のみ。

## 1. 秘密情報と安全規約

`docs/test-app/` は削除済みで、接続情報はリポジトリ外 `~/.ksql-flow-dev/dev.env` にある。local `ksql.config.json` は gitignore 対象で、実値ではなく `env:` 参照だけを持つ。

最終確認:

- 書込先は業務アプリ 4246 / 4247 と実行ログ 4249。4245 / 4248 は読取だけ
- 作成・更新・削除した業務データは検証プレフィックスだけ
- `dev.env` は全工程で読取のみ。無効 token は子プロセス環境だけ上書き
- `limits.maxApiCalls = 2000`、最終 RUNNING ログ 0
- `../kintone-sql-tools` は変更していない
- `dev.env` 内の実ドメイン・token 値とリポジトリ全ファイルの完全一致 0

## 2. dev 設定

local `ksql.config.json` の dev profile:

- apps 4245〜4248 と実行ログ 4249、`logApp: "実行ログ"`
- 実行ログ token は `env:KSQL_DEV_TOKEN_LOGS`
- 案件管理は `env:KSQL_DEV_TOKEN_DEAL` と lookup 参照元の `env:KSQL_DEV_TOKEN_CUSTOMER` を併送
- `logging.maskFields` と `logging.stripLiterals: true`
- `timezone: Asia/Tokyo`、`limits.maxApiCalls: 2000`

案件 INSERT の初回実行で lookup 参照元 token 不足が実機で判明した。顧客 1 件だけが作成され、案件書込前に Exit 3 で停止した。local config に参照元 token を追加後、同じ seed が成功した。

## 3. 0-2 ログアプリ検査

ログアプリは browser console 方式で生成済み（app 4249）。

> **後日追記（2026-08-22）**: 一般利用者向けの作成手順は、レイアウト・一覧設定済みの**同梱アプリテンプレート**（template/ksql-flow-log-template1.zip）から作成する方式へ変更した（README / template/README.md / 設計書 v2.8 付録 B）。テンプレートのフィールド定義は 8.2 と機械突合済み（job_key unique 含む・秘密情報ゼロ）。console スクリプト（verification/logapp-console.js）と init-logapp は代替手段として残る。

```powershell
./verification/run-dev.ps1 validate --check-logapp --profile dev
```

結果: `OK: ログアプリ (ID 4249) は 8.2 のフィールド定義を満たしています` / Exit 0。`job_key` の重複禁止を含む全定義が一致した。

## 4. 検証資材

- `verification/jobs/`: master read、aggregate、専用 NO_DATA
- `verification/seed/`: normal（顧客 1 + 案件 260）と negative
- `verification/resume/`: 先行成功と後続認証失敗を分けた 2 JOB
- `verification/cleanup/01_remove_negative.sql`: negative だけを完全一致で除去
- `verification/cleanup/99_cleanup_all.sql`: 全検証データの任意後片付け。今回は未実行

全ディレクトリを実 client 付き `validate-all` で検証し Exit 0。素の INSERT に対する KSQL1305 警告だけを意図どおり受容した。

## 5. normal seed とチャンク

```powershell
./verification/run-dev.ps1 run -f verification/seed/01_seed_normal.sql --profile dev
```

| status | Exit | read_count | written_count | api_calls |
| --- | ---: | ---: | ---: | ---: |
| SUCCESS | 0 | 1 | 261 | 11 |

実レコード件数は顧客 1、案件 260。JSONL `write_chunk` は 1 / 100 / 100 / 60 件で、案件 INSERT は 100 / 100 / 60 の 3 チャンクだった。ログ JOB も SUCCESS / read 1 / written 261 / API 11。`last_written_key` は非空で取得したが業務キーのため非転記。`job_key` は空、`job_key_done` は設定済み。

## 6. 0-3 validate → dry-run → run

```powershell
./verification/run-dev.ps1 validate -f verification/jobs/02_aggregate_deals.sql --profile dev
./verification/run-dev.ps1 run -f verification/jobs/02_aggregate_deals.sql --profile dev --dry-run --sample 1 --json
```

validate は OK / Exit 0。dry-run は次のとおり。

| status | Exit | read records | API total | read API | preview API | INSERT | UPDATE | DELETE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SUCCESS | 0 | 276 | 6 | 5 | 1 | 0 | 1 | 0 |

対象顧客は前 1 / 後 1、案件は前 260 / 後 260。サンプル値は伏字。業務 mutation 0、ログアプリ書込 0、state 更新 0。

```powershell
./verification/run-dev.ps1 run -f verification/jobs/02_aggregate_deals.sql --profile dev
```

| status | Exit | read_count | written_count | api_calls | 実対象 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SUCCESS | 0 | 277 | 1 | 8 | 1 |

dry-run 予告 `INSERT 0 / UPDATE 1 / DELETE 0` と run の written 1 が一致。ログ JOB も同値で、`last_written_key = ***`、`job_key` 空、`job_key_done` 設定済み。

## 7. 0-4-a ASSERT と cleanup

```powershell
./verification/run-dev.ps1 run -f verification/seed/02_seed_negative.sql --profile dev
./verification/run-dev.ps1 run -f verification/jobs/02_aggregate_deals.sql --profile dev
```

| status | Exit | read_count | written_count | api_calls | 対象顧客 前 / 後 |
| --- | ---: | ---: | ---: | ---: | ---: |
| ABORTED | 2 | 1 | 0 | 4 | 1 / 1 |

```powershell
./verification/run-dev.ps1 run -f verification/cleanup/01_remove_negative.sql --profile dev
```

cleanup は SUCCESS / Exit 0 / written 1。除去後 negative 0。

## 8. 0-4-b NO_DATA

```powershell
./verification/run-dev.ps1 run -f verification/jobs/03_no_data.sql --profile dev
```

| status | Exit | read_count | written_count | api_calls |
| --- | ---: | ---: | ---: | ---: |
| NO_DATA | 0 | 276 | 0 | 4 |

ログ JOB も NO_DATA、`job_key` 空、`job_key_done` 設定済み。notification URL 未設定のため外部通知 0。

## 9. 0-4-c 二重起動

Node `child_process.spawn` で同じ `node dist/cli.js run ...` を同時に 2 本起動した。終了コードは Exit 0 / 5。完了直後の単独再実行は Exit 0。最終 RUNNING レコード 0、`job_key` クリアを確認した。

## 10. 0-4-d resume と実機不具合修正

子プロセスだけ `KSQL_DEV_TOKEN_CUSTOMER` を無効値へ上書きし、`dev.env` 本体は変更していない。

```powershell
node dist/cli.js run-all verification/resume --profile dev
./verification/run-dev.ps1 run-all verification/resume --profile dev --resume
```

失敗 run-all は Exit 3、先行 SUCCESS 1、後続 FAILED 1。resume は Exit 0、後続 1 JOB だけ実行した。

| record | status | read_count | written_count | api_calls | JOB 構成 |
| --- | --- | ---: | ---: | ---: | --- |
| 元 BATCH | FAILED | 1 | 0 | 10 | SUCCESS 1 / FAILED 1 |
| resume BATCH | SUCCESS | 277 | 1 | 12 | SUCCESS 1 |
| resume JOB | SUCCESS | 277 | 1 | 7 | 失敗した後続だけ |

両 BATCH と全 JOB の `as_of` は同一実値。`job_key` は全て空、`job_key_done` は全て設定済み。

初回 resume では DROP_DOWN の `record_type` に `=` を使っていたため実 kintone が拒否し、state fallback になった。`src/logapp.ts` の `record_type` / `status` query を `IN (...)` へ修正し、3 query の回帰テストを追加。修正後の再実測は fallback 表示なしでログアプリを正に resume 成功。

## 11. Takashi さん向け 0-5 Webhook 実受信手順

受信 URL はリポジトリや画面共有ログへ残さない。negative は現在 0 件なので、投入→受信確認→cleanup の順で実行する。

```powershell
./verification/run-dev.ps1 run -f verification/seed/02_seed_negative.sql --profile dev

$env:KSQL_DEV_WEBHOOK_URL = Read-Host "Webhook URL"
$tempConfig = Join-Path $env:TEMP "ksql-flow-webhook-check.json"
$cfg = Get-Content -Raw .\ksql.config.json | ConvertFrom-Json
$notifications = [pscustomobject]@{
  onFailure = [pscustomobject]@{ webhook = "env:KSQL_DEV_WEBHOOK_URL" }
}
$cfg.profiles.dev | Add-Member -Force NoteProperty notifications $notifications
$cfg | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $tempConfig

./verification/run-dev.ps1 run -f verification/jobs/02_aggregate_deals.sql --profile dev --config $tempConfig
"Exit=$LASTEXITCODE (expected: 2 / ABORTED)"

./verification/run-dev.ps1 run -f verification/cleanup/01_remove_negative.sql --profile dev
Remove-Item -LiteralPath $tempConfig
Remove-Item Env:KSQL_DEV_WEBHOOK_URL
```

確認: ABORTED / Exit 2、JSON POST 1 回、payload は source / profile / status / exit_code のみを確認し、URL・認証情報・レコード値を記録しない。cleanup 後 negative 0。

### 実施結果（2026-08-22・Takashi さん実施 — PASS）

- negative seed 投入: SUCCESS / Exit 0 / 書込 1
- aggregate 実行: **ABORTED / Exit 2**・読取 1 / 書込 0 / API 4・ASSERT メッセージ表示（エラー文中の `APP900000000` はエンジン内部の論理アプリ写像 ID であり実アプリ ID ではない）
- **Webhook 実受信: JSON POST 1 回を受信確認**（受信 URL は方針どおり非記録）
- cleanup: SUCCESS / Exit 0 / 書込(削除) 1 → negative 0 件

## 12. Takashi さん向け 0-6 タスクスケジューラ手順

> **初回試行の失敗（2026-08-22 10:21・手順書の不備）**: 初版手順は `$repo = (Resolve-Path .).Path` で
> カレントディレクトリに依存しており、リポジトリ外から登録すると `run-dev.ps1` の実在しないパスが
> タスクに登録され、`LastTaskResult = 4294770688`（0xFFFD0000 = PowerShell が `-File` 対象を
> 発見できず即終了）となった。ログアプリに該当時刻の BATCH が無いこと（CLI 未起動）も確認済み。
> ランナー本体・ラッパーの不具合ではない。以下はリポジトリパスを固定した修正版。

```powershell
# どのディレクトリから実行しても良い（パスは絶対指定）
$repo = "C:\Users\rex02\Projects\ksql-flow"
$runner = Join-Path $repo "verification\run-dev.ps1"
$log = Join-Path $env:TEMP "ksql-flow-task-0-6.log"
$taskName = "kSQL Flow Phase0 one-shot"
$actionArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$runner' run-all verification/jobs --profile dev *> '$log'; exit `$LASTEXITCODE`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force
Start-ScheduledTask -TaskName $taskName
```

1〜2 分待って完了後:

```powershell
Get-ScheduledTaskInfo -TaskName "kSQL Flow Phase0 one-shot" | Format-List LastRunTime,LastTaskResult
Get-Content (Join-Path $env:TEMP "ksql-flow-task-0-6.log")   # 各ジョブの実行結果
# LastTaskResult = 0 とログアプリ BATCH / JOB（started_at が実行時刻）を突合
Unregister-ScheduledTask -TaskName "kSQL Flow Phase0 one-shot" -Confirm:$false
Remove-Item (Join-Path $env:TEMP "ksql-flow-task-0-6.log")
```

期待値: `LastTaskResult = 0`・ログに 3 ジョブ（sync SUCCESS / aggregate SUCCESS / no_data NO_DATA）・ログアプリに実行時刻の BATCH（SUCCESS）と JOB 3 件。自動再起動は設定せず、失敗時は `--resume` を使う。

### 実機知見（3 件目）: BOM なし UTF-8 の PowerShell スクリプトは 5.1 でパースエラー

2 回目の試行（`-File` 方式）でも 0.1 秒の無出力終了となった。PowerShell 5.1 直接実行で再現させたところ、**日本語を含む `run-dev.ps1` が BOM なし UTF-8 のため、5.1 が ANSI として読み文字列リテラルが化けてパースエラー**になっていた（pwsh 7 は UTF-8 既定のため単体確認では通過していた）。`run-dev.ps1` / `task-0-6.ps1` を **BOM 付き UTF-8** に変換して解消。タスクスケジューラの既定は powershell.exe (5.1) のため、利用者のバッチ運用でも踏みやすい罠 — Phase 1 の README / examples 注記へ反映する。

### 実施結果（2026-08-22・Takashi さん実施 — PASS）

- タスク実行: `LastRunTime 10:36:41`・**`LastTaskResult = 0`**（PSVersion 5.1.26100.9168）
- 実行ログ: 3 ジョブ完走（sync SUCCESS 読取 2 / aggregate SUCCESS 読取 277・書込 1 / no_data NO_DATA 読取 276）・`task finished exit=0`
- **ログアプリ突合（batch 328d76d0…）**: BATCH = SUCCESS・started_at 01:36 UTC（タスク実行時刻と一致）・read 555（= 2+277+276）・written 1・API 23・`job_key` クリア + `job_key_done` 退避済み・配下 JOB 3 件のステータス一致

## 13. 最終状態と回帰

検証データは Takashi さん確認用に残した。

| 種別 | 件数 |
| --- | ---: |
| 検証顧客 | 1 |
| normal 案件 | 260 |
| negative 案件 | 0 |
| RUNNING ログ | 0 |

`verification/cleanup/99_cleanup_all.sql` は用意済みだが未実行。

- `npm test -- --runInBand`: PASS（9 suites / 101 tests）
- `npm run build`: PASS
- `validate --check-logapp`: PASS / Exit 0
- 全 verification SQL の実 client 付き validate: PASS
- `dev.env` 実値のリポジトリ内完全一致: 0
- `../kintone-sql-tools`: 変更なし

