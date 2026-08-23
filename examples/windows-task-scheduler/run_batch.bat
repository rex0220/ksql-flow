:: kSQL Flow: Windows Task Scheduler entry point (see register_task.ps1)
:: Layout assumes a jobs repository created from ksql-flow-template
:: (package.json + .env + jobs/), cloned to C:\ksql\my-ksql-jobs.
::   - Tokens come from .env in the repo (gitignored). No user-env dependency.
::   - Node is invoked directly (not "npm run") so the ksql-flow exit code
::     reaches LastTaskResult unchanged (0/2/3/4/5).
::   - Do NOT enable "restart on failure" on the task. Reruns are handled by
::     "ksql-flow run-all --resume" (idempotent, guarded by the duplicate-run lock).
@echo off
cd /d C:\ksql\my-ksql-jobs
node --env-file=.env node_modules\@rex0220\ksql-flow\dist\cli.js run-all .\jobs --profile prod
exit /b %ERRORLEVEL%
