#!/usr/bin/env bash
# done-means: PR tobi/qmd#375 (Postgres + pgvector backend) is merged into the
# tree under judgment — both new source files exist, no file carries a
# conflict marker, and the driver is declared.
#   0 pass · 1 merge absent or conflicted · 3 harness error
set -u
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo" || { echo "HARNESS ERROR: cannot cd $repo"; exit 3; }
command -v rg >/dev/null 2>&1 || { echo "HARNESS ERROR: rg not on PATH"; exit 3; }
fail=0
for f in src/pg.ts src/pg-worker.ts; do
  if [ -f "$f" ]; then echo "PASS $f present"; else echo "FAIL $f absent"; fail=1; fi
done
markers=$(rg -l '^(<<<<<<<|=======|>>>>>>>) ' src test package.json bun.lock README.md CHANGELOG.md 2>/dev/null || true)
if [ -n "$markers" ]; then echo "FAIL conflict markers in: $markers"; fail=1; else echo "PASS no conflict markers"; fi
if rg -q '"postgres"' package.json; then echo "PASS postgres driver declared"; else echo "FAIL postgres driver not in package.json"; fail=1; fi
exit $fail
