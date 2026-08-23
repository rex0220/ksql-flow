<!--
title: 【kSQL Flow #4】タスクスケジューラで毎朝動かす — PowerShell が 0.1 秒で無言死する罠つき
tags:
  - kintone
  - SQL
  - PowerShell
  - タスクスケジューラ
-->

> **as-is / no support**: 本ツールは MIT ライセンスで現状有姿のまま公開しており、サポート・動作保証・修正の約束はありません。本番投入は必ず `--dry-run` とステージング検証を経て、自己責任でお願いします。

- GitHub: https://github.com/rex0220/ksql-flow （[タスクスケジューラの実例](https://github.com/rex0220/ksql-flow/tree/main/examples/windows-task-scheduler)）
- 前回: [【kSQL Flow #3】毎朝の無人実行の前に — kintone バッチを 200 → 20,000 → 100,000 件で鍛える](https://qiita.com/rex0220/items/62e950ab1ccc5b54ff69)

[#3](https://qiita.com/rex0220/items/62e950ab1ccc5b54ff69) で 10 万件・強制切断・API 枯渇まで鍛えた kintone バッチを、いよいよ**毎朝の無人実行**に載せます。実行環境は Windows タスクスケジューラ。リリース前の実機検証でここを通したとき、**私は 2 回失敗しました** — その失敗ログごとお見せします。

## 最初に正直な位置づけを

タスクスケジューラは、**単体では本番バッチ基盤の水準にありません**。失敗通知はなく、無言で死んでも `LastTaskResult` を見に行くまで気づけず、サーバー 1 台の SPOF です。これから環境を用意できるなら、GitHub Actions（無料枠）や月 1,000 円前後の VPS + cron を先に検討してください（[#1 の整理](https://qiita.com/rex0220/items/893ab4016a5aaf595642)）。

それでも本記事を書くのは、**すでに社内 Windows サーバーが動いている環境には追加コストゼロの現実解**だからです（中堅・中小の約 44% はクラウドサーバー非導入という調査もあります）。そして弱点の大半は、ランナー側が引き受けられます。

| 足りないもの | 誰が持つか |
| --- | --- |
| 失敗通知 | ランナーの Webhook（+ 成功 heartbeat） |
| 実行記録 | kintone のログアプリ（スケジューラのログを見なくても kintone 側で確認） |
| 多重起動の防止 | ローカルロック + ログアプリの分散ロック（Exit 5） |
| 失敗からの復旧 | 冪等リラン `--resume`（#3 で強制切断から収束を実証済み） |
| **そもそも起動しなかった事故** | **ランナーでは拾えない** — heartbeat の「不在」を人間か外部監視が見るしかない（本記事の最後に再掲） |

つまりスケジューラの役割は「**決まった時刻に 1 コマンド叩く装置**」だけに絞ります。

## 前提と構成

ジョブと設定は #1（手作り最小構成）でも #2（テンプレートリポジトリ）でも構いません。無人化の前提となる 3 点 — 二重起動が Exit 5 で止まる・通知が届く・非対話シェルで動く — は #3 の無人運用ゲートで確認済みという状態から始めます。

起動には **ASCII だけの .bat** を使います（[examples/windows-task-scheduler/run_batch.bat](https://github.com/rex0220/ksql-flow/blob/main/examples/windows-task-scheduler/run_batch.bat)）:

```bat
@echo off
cd /d C:\ksql\project
ksql-flow run-all .\jobs\ --profile prod
if %ERRORLEVEL% GEQ 1 exit /b %ERRORLEVEL%
```

.ps1 でなく .bat なのは好みではありません — **後述の罠②を構造的に回避するため**です。

### 無人実行のトークン設計

[#2](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa) では「書込トークンはセッション限定・恒久的な環境変数にしない」としました。あれは**AI が同居する開発機**の分離設計です。無人実行するサーバーでは前提が変わります — 人間のセッションが無いので、**タスクを実行するアカウントの環境変数**に `KSQL_TOKEN_*` を置きます。

- 推奨は**バッチ専用の実行アカウント**（人が普段使わない）を作り、そのユーザー環境変数に設定。トークンの露出面がそのアカウントに閉じます
- 開発機と運用サーバーを兼ねる場合（今回の検証環境がそうです）は、AI ツールを使うユーザーと実行アカウントを分けることが #2 の分離を保つ条件になります

## タスク登録（動作確認済み）

登録も PowerShell 1 発です（[examples/windows-task-scheduler/register_task.ps1](https://github.com/rex0220/ksql-flow/blob/main/examples/windows-task-scheduler/register_task.ps1)）:

```powershell
$batchPath = "C:\ksql\project\run_batch.bat"   # 絶対パスで（後述の罠①）
$taskName  = "kSQL Flow daily batch"

$action    = New-ScheduledTaskAction -Execute $batchPath -WorkingDirectory (Split-Path $batchPath)
$trigger   = New-ScheduledTaskTrigger -Daily -At 6:00
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

ポイントは 2 つ。**「実行に失敗したとき再起動する」は設定しない**（理由は後述）。ログオフ中も動かす本番運用では、`-LogonType` を専用アカウントの「ユーザーがログオンしているかどうかにかかわらず実行」（または gMSA）に切り替えます。

実行後の確認はこの 2 つを突き合わせます:

```powershell
Get-ScheduledTaskInfo -TaskName "kSQL Flow daily batch" | Format-List LastRunTime,LastTaskResult
```

`LastTaskResult` は **kSQL Flow の Exit Code がそのまま入ります**（0 = 成功 / 2 = 業務異常 / 3 = 実行時エラー / 5 = 多重起動）。そして詳細は kintone のログアプリ側 — 何件読んで何件書いたか・エラー全文・実行時刻は、サーバーに入らなくても kintone を開けば見えます。

## 罠 ①: `LastTaskResult = 4294770688`

リリース前検証での 1 回目の失敗です。登録した覚えのない値が返ってきました。

```
LastRunTime    : 2026/08/22 10:21:XX
LastTaskResult : 4294770688
```

4294770688 = **0xFFFD0000** = PowerShell が `-File` の対象を発見できずに即終了したときの値です。原因は登録スクリプトがパスを `(Resolve-Path .)` で組んでいたこと — **登録した時のカレントディレクトリに依存**し、別の場所から登録した瞬間に存在しないパスがタスクに焼き付きました。

このとき効いた切り分けが「**ログアプリに該当時刻の BATCH レコードが無い**」ことです。ランナーは起動すれば必ず実行記録を残すので、記録が無い = CLI まで到達していない = タスク側の問題、と一発で確定します。対策は単純で、**タスクに入れるパスはすべて絶対指定**（上の登録スクリプトは修正済みの形です）。

## 罠 ②: 0.1 秒で無言死する PowerShell

2 回目。パスを直したのに、今度は **0.1 秒で終了・出力ゼロ**。ログファイルは空、しかし `LastTaskResult` は正常系に見える — 一番嫌なタイプの死に方です。

PowerShell 5.1 で直接実行して再現させた結果、原因はエンコーディングでした。

- 起動スクリプト（日本語コメント入り .ps1）が **BOM なし UTF-8** だった
- **タスクスケジューラの既定シェルは Windows PowerShell 5.1**。5.1 は BOM なし UTF-8 を **ANSI として読む**ため、日本語リテラルが化けてパースエラー → 何も出力せず即死
- 手元の確認で通っていたのは **pwsh 7**（UTF-8 既定）だったから。「手で動くのにタスクだと死ぬ」の正体がこれ

対策は 3 択です: **①日本語を含む .ps1 は UTF-8 BOM 付きで保存**する、②起動スクリプトを **ASCII だけの .bat** にする（本記事の構成。エンコーディング問題が構造的に消えます）、③タスクの実行プログラムを pwsh 7 に明示する。ちなみに examples の登録スクリプトのコメントを英語にしてあるのは、この罠を仕組みで避けるためです。

修正後の 3 回目で完走しました:

```
LastRunTime    : 2026/08/22 10:36:41
LastTaskResult : 0
```

（PSVersion 5.1.26100.9168。ログアプリには実行時刻の BATCH 1 件 + JOB 3 件 — SUCCESS / SUCCESS / NO_DATA — が残り、コンソールログと完全一致）

## 「失敗したら再起動」を使わない理由

タスクスケジューラには「実行に失敗したとき再起動する」設定がありますが、**使いません**。理由は 2 つ。

1. **多重起動ロックと衝突します。** ランナーが異常な死に方をした直後はロック（ログアプリの RUNNING レコード）が残っていることがあり、スケジューラが機械的に再起動しても Exit 5 で弾かれるだけです — それは正しい防御であって、再起動で解決する状況ではありません
2. **失敗の種類を見ずに再実行するのは危険です。** Exit 2（業務異常）は「データを直すまで何度流しても止まるべき」失敗であり、自動再起動は無意味です。復旧はランナー側の冪等リラン `--resume` に一本化します — 部分書込からの収束は #3 で強制切断込みで実証済みで、翌朝の定時実行または人間の 1 コマンドで正しい状態に戻ります

これは他の環境でも同じで、GitHub Actions や EventBridge でも「スケジューラ側リトライは 0」が本連載の原則です。

## 残る穴 — 「起動しなかった」だけは拾えない

最後にもう一度正直に。ランナーがどれだけ装備を持っても、**スケジューラがそもそも起動しなかった事故**（サーバー停止・Windows Update 再起動・タスク無効化）はランナーには観測できません。手当ては heartbeat です — 成功時にも Webhook を打つ設定にしておき、「**毎朝来るはずの通知が来ない**」ことを検知の頼りにします。通知チャネル側の仕組み（Slack のリマインダーや外部監視）で「不在」を拾えるならなお良し。ここを自動化しきれないことが、タスクスケジューラ運用の受け入れるべき限界です。

## まとめ

- スケジューラは「定時に 1 コマンド叩く装置」に格下げし、通知・記録・排他・リランはランナーが持つ — この分担なら現実解として成立する
- 罠は 2 つ実機で踏んだ: **絶対パス以外は登録するな**（0xFFFD0000）、**日本語 .ps1 は BOM 付きで**（5.1 の ANSI 解釈で 0.1 秒無言死）。ASCII の .bat 起動が最も構造的に安全
- `LastTaskResult` = Exit Code の一次判定、詳細は kintone のログアプリ。**「ログアプリに記録が無い = CLI 未到達」**が切り分けの武器になる
- 自動再起動は使わず、復旧は冪等リラン `--resume` に一本化
- 「起動しなかった」だけは heartbeat の不在検知で人間が拾う

## 連載

1. **#1**: [kintone のバッチ処理を SQL 1 本で書けるランナーの紹介](https://qiita.com/rex0220/items/893ab4016a5aaf595642)
2. **#2**: [AI エージェントに kintone のバッチジョブを書かせる — MCP + Claude Code](https://qiita.com/rex0220/items/3a1213a596a8c49b67aa)
3. **#3**: [毎朝の無人実行の前に — kintone バッチを 200 → 20,000 → 100,000 件で鍛える](https://qiita.com/rex0220/items/62e950ab1ccc5b54ff69)
4. **#4（本記事）**: タスクスケジューラで毎朝動かす
5. 以降、GitHub Actions / cron・Docker / AWS / Azure / GCP の環境別と、排他・冪等リランの設計深掘りを予定
