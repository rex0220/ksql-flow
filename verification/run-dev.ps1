$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$repoOwnerHome = Split-Path -Parent (Split-Path -Parent $repoRoot)
$envCandidates = @(
  $env:KSQL_DEV_ENV_FILE
  (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".ksql-flow-dev/dev.env")
  (Join-Path $repoOwnerHome ".ksql-flow-dev/dev.env")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
$envFile = $envCandidates | Select-Object -First 1

if (-not $envFile) {
  throw "検証用環境変数ファイルが見つかりません。KSQL_DEV_ENV_FILE または ~/.ksql-flow-dev/dev.env を確認してください"
}

foreach ($line in Get-Content -LiteralPath $envFile) {
  $trimmed = $line.Trim()
  if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
    continue
  }
  $separator = $trimmed.IndexOf("=")
  if ($separator -le 0) {
    throw "dev.env に KEY=VALUE 形式でない行があります"
  }
  $name = $trimmed.Substring(0, $separator).Trim()
  $value = $trimmed.Substring($separator + 1)
  if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "dev.env に不正な環境変数名があります"
  }
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

$cli = Join-Path $repoRoot "dist/cli.js"
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "dist/cli.js がありません。先に npm run build を実行してください"
}

Push-Location $repoRoot
try {
  & node $cli @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
