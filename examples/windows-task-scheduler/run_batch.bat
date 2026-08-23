:: kSQL Flow: scheduler entry point (Windows Task Scheduler / any scheduler).
:: Path-independent: %~dp0 = the directory this .bat lives in (the repo root),
:: so this works wherever the repository is cloned. Keep this file ASCII-only.
::   - Tokens come from .env in the repo (gitignored).
::   - Node is invoked directly (not "npm run") so the ksql-flow exit code
::     reaches the scheduler (LastTaskResult) unchanged: 0/2/3/4/5.
::   - Do NOT enable "restart on failure" on the task. Reruns are handled by
::     "ksql-flow run-all --resume" (idempotent, guarded by the duplicate-run lock).
@echo off
cd /d %~dp0
node --env-file=.env node_modules\@rex0220\ksql-flow\dist\cli.js run-all .\jobs --profile prod
exit /b %ERRORLEVEL%
