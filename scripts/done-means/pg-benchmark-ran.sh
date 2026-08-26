#!/usr/bin/env bash
# done-means: the Postgres-backend benchmark was RUN and recorded — a record
# file names wall times for both `qmd update` and `qmd embed` and the
# baseline they are measured against (4m13s on Development, 2026-08-26).
#   0 pass · 1 record missing or incomplete · 3 harness error
# Override: PG_BENCH_RECORD=<path> (default _DOCS/postgres-benchmark.md).
set -u
repo=$(cd "$(dirname "$0")/../.." && pwd)
record="${PG_BENCH_RECORD:-$repo/_DOCS/postgres-benchmark.md}"
command -v rg >/dev/null 2>&1 || { echo "HARNESS ERROR: rg not on PATH"; exit 3; }
[ -f "$record" ] || { echo "FAIL no benchmark record at $record"; exit 1; }
fail=0
need() { if rg -q "$1" "$record"; then echo "PASS $2"; else echo "FAIL $2"; fail=1; fi; }
need 'qmd update.*[0-9]+m[0-9.]+s|qmd update.*[0-9.]+s' 'qmd update wall time'
need 'qmd embed.*[0-9]+m[0-9.]+s|qmd embed.*[0-9.]+s' 'qmd embed wall time'
need '4m13s' 'baseline 4m13s named'
need '10\.71\.20\.167' 'cluster host named'
exit $fail
