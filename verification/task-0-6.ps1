# 0-6 検証用: タスクスケジューラから起動される一発スクリプト。
# 起動直後にマーカー行を書くため、「powershell が起動したか」自体をログで判別できる。
$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "ksql-flow-task-0-6.log"
"task started at $(Get-Date -Format o) (PSVersion $($PSVersionTable.PSVersion))" | Set-Content -Encoding utf8 $log
& (Join-Path $PSScriptRoot "run-dev.ps1") run-all verification/jobs --profile dev *>> $log
$code = $LASTEXITCODE
"task finished exit=$code at $(Get-Date -Format o)" | Add-Content -Encoding utf8 $log
exit $code
