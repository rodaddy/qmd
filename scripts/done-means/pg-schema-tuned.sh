#!/usr/bin/env bash
# done-means: the Postgres branch emits the configuration FORK.md measured:
# halfvec(768), HNSW m=32 / ef_construction=128, to_tsquery OR-terms,
# ts_rank_cd — and NOT websearch_to_tsquery (ANDs terms; silent zero results).
#   0 pass · 1 any row missing or the AND parser still present · 3 harness error
set -u
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo" || { echo "HARNESS ERROR: cannot cd $repo"; exit 3; }
command -v rg >/dev/null 2>&1 || { echo "HARNESS ERROR: rg not on PATH"; exit 3; }
files="src/pg.ts src/store.ts"
for f in $files; do [ -f "$f" ] || { echo "HARNESS ERROR: $f absent (merge not applied)"; exit 3; }; done
fail=0
need() { if rg -q "$1" $files; then echo "PASS $2"; else echo "FAIL $2"; fail=1; fi; }
need 'halfvec\(768\)' 'halfvec(768)'
need 'm *= *32' 'HNSW m=32'
need 'ef_construction *= *128' 'HNSW ef_construction=128'
need 'ts_rank_cd' 'ts_rank_cd'
need '[^_]to_tsquery' 'to_tsquery'
if rg -q 'websearch_to_tsquery' $files; then echo "FAIL websearch_to_tsquery still present"; fail=1; else echo "PASS no websearch_to_tsquery"; fi
if rg -q '\bts_rank\(' $files; then echo "FAIL plain ts_rank( still present"; fail=1; else echo "PASS no plain ts_rank("; fi
exit $fail
