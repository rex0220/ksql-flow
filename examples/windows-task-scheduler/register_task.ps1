# Register the kSQL Flow daily batch task (runs run_batch.bat every morning).
# See: examples/windows-task-scheduler/run_batch.bat
#
# NOTE: comments in this file are intentionally ASCII-only.
#       Task Scheduler launches Windows PowerShell 5.1 by default, and 5.1 reads
#       BOM-less UTF-8 scripts as ANSI: non-ASCII literals get mangled and the
#       script dies with a parse error in ~0.1s, leaving no output.
#       If you add Japanese comments/strings, save the file as UTF-8 *with BOM*.
#
# NOTE: use absolute paths only. Registering with a path resolved from the
#       current directory produces LastTaskResult = 4294770688 (0xFFFD0000)
#       when the task later starts from a different working directory.
#
# NOTE: do NOT enable "restart on failure" on the task. Reruns are handled by
#       "ksql-flow run-all --resume" (idempotent, guarded by the duplicate-run lock).

$batchPath = "C:\ksql\project\run_batch.bat"   # <- absolute path to your copy
$taskName  = "kSQL Flow daily batch"

$action    = New-ScheduledTaskAction -Execute $batchPath -WorkingDirectory (Split-Path $batchPath)
$trigger   = New-ScheduledTaskTrigger -Daily -At 6:00
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
# Interactive = runs while the user is logged on. For unattended servers, switch to
# a dedicated account with "Run whether user is logged on or not" (password stored)
# or a gMSA, and make sure that account has the KSQL_TOKEN_* environment variables.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force

# Verify after the first run:
#   Get-ScheduledTaskInfo -TaskName "kSQL Flow daily batch" | Format-List LastRunTime,LastTaskResult
#   (LastTaskResult maps 1:1 to ksql-flow exit codes: 0=success, 2=assert, 3=runtime, 5=locked)
# Remove:
#   Unregister-ScheduledTask -TaskName "kSQL Flow daily batch" -Confirm:$false
