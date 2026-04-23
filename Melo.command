#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

cd "$SCRIPT_DIR"

mkdir -p .tmp
date '+%Y-%m-%d %H:%M:%S' > .tmp/last-launch.txt
echo "$$" > .tmp/last-launch-pid.txt

export MELO_HOME="${MELO_HOME:-$SCRIPT_DIR/.tmp/melo-home-user}"

if [[ "${MELO_AUTO_EXIT:-0}" == "1" || -f .tmp/test-auto-exit ]]; then
  rm -f .tmp/test-auto-exit
  printf '/exit\n' | node src/index.js
else
  exec node src/index.js
fi
