#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_owner_home=$(CDPATH= cd -- "$repo_root/../.." && pwd)
env_file=${KSQL_DEV_ENV_FILE:-"${HOME}/.ksql-flow-dev/dev.env"}

if [ ! -f "$env_file" ] && [ -f "$repo_owner_home/.ksql-flow-dev/dev.env" ]; then
  env_file="$repo_owner_home/.ksql-flow-dev/dev.env"
fi

if [ ! -f "$env_file" ]; then
  echo "検証用環境変数ファイルが見つかりません: $env_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

cli="$repo_root/dist/cli.js"
if [ ! -f "$cli" ]; then
  echo "dist/cli.js がありません。先に npm run build を実行してください" >&2
  exit 1
fi

cd "$repo_root"
exec node "$cli" "$@"
