#!/usr/bin/env bash
# done-means: the TypeScript build config type-checks (`npm run test:types`).
#   0 pass · 1 tsc reported errors · 3 harness error (deps not installed)
set -u
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo" || { echo "HARNESS ERROR: cannot cd $repo"; exit 3; }
[ -f node_modules/typescript/bin/tsc ] || { echo "HARNESS ERROR: node_modules/typescript missing (run bun install --no-scripts)"; exit 3; }
if npm run --silent test:types; then echo "PASS test:types"; exit 0; fi
echo "FAIL test:types"; exit 1
