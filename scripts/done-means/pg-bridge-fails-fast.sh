#!/usr/bin/env bash
# done-means: the Postgres sync bridge FAILS FAST. A worker that cannot
# connect (bad URL, dead host, crashed worker) must surface as a thrown error
# on the main thread, never an indefinite Atomics.wait. Observed 2026-08-26:
# `qmd status` hung forever because the local .qmd sqlite path reached
# openPgDatabase() and the worker died before it could notify.
#   0 pass · 1 the bridge hung (killed at the deadline) or returned success
#   3 harness error
# No database is contacted: the URL is a filesystem path that can never connect.
set -u
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo" || { echo "HARNESS ERROR: cannot cd $repo"; exit 3; }
[ -f node_modules/tsx/package.json ] || { echo "HARNESS ERROR: tsx missing (bun install --no-scripts)"; exit 3; }
command -v timeout >/dev/null 2>&1 || { echo "HARNESS ERROR: timeout not on PATH"; exit 3; }
deadline="${PG_BRIDGE_DEADLINE_S:-30}"
timeout -s KILL "$deadline" node --import tsx/esm scripts/done-means/pg-bridge-fails-fast.mjs
rc=$?
if [ "$rc" -eq 137 ]; then echo "FAIL bridge hung past ${deadline}s (killed)"; exit 1; fi
exit "$rc"
