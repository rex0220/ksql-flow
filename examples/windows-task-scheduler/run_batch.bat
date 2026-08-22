:: 設計書 付録 A-2: Windows タスクスケジューラから毎朝 6:00 に起動
:: 注意: タスクの「実行に失敗したとき再起動」は使用しないこと。
::       リランは ksql-flow run-all --resume に一本化し、多重起動ロックに委ねる。
:: PowerShell 5.1 の .ps1 に置き換える場合、日本語を含むファイルは UTF-8 BOM 付きで保存すること。
@echo off
cd /d C:\ksql\project
ksql-flow run-all .\jobs\ --profile prod
if %ERRORLEVEL% GEQ 1 exit /b %ERRORLEVEL%
