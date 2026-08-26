#!/opt/homebrew/bin/bash
# Time `qmd update` + `qmd embed` through the Postgres backend.
#
#   scripts/bench-postgres.sh <dir-with-.qmd> <label>
#
# Runs from <dir> so qmd resolves that directory's .qmd/index.yml (qmd walks
# UP from cwd; name the directory, never assume). The connection URL is built
# from Vaultwarden at run time ("PostgreSQL - general qmd"): no secret file,
# nothing to commit. Bypasses the librarian (AQMD_VIA_LIBRARIAN=0,
# LIBRARIAN_CHILD=1) so the number is qmd's, not the queue's.
# Log: <dir>/.qmd/bench-<label>.log (gitignored by the .qmd rules; copy the
# numbers into _DOCS/postgres-benchmark.md by hand).
set -u
dir=${1:?dir with .qmd}; label=${2:?label}
here=$(cd "$(dirname "$0")/.." && pwd)
QMD="$here/dist/cli/qmd.js"
[ -f "$QMD" ] || { echo "HARNESS ERROR: $QMD missing (npm run build)"; exit 3; }
pw=$(timeout 30 mcp2cli vaultwarden-secrets get_credential --params '{"query":"PostgreSQL - general qmd"}' | jq -r '.result.value')
[ -n "$pw" ] && [ "$pw" != "null" ] || { echo "HARNESS ERROR: no credential"; exit 3; }
export QMD_BACKEND=postgres
export QMD_POSTGRES_URL="postgresql://qmd:${pw}@10.71.20.167:5432/qmd"
export AQMD_VIA_LIBRARIAN=0 LIBRARIAN_CHILD=1
cd "$dir" || exit 3
log="$dir/.qmd/bench-$label.log"
{
  echo "== $label start $(date -u +%FT%TZ) cwd=$(pwd) backend=postgres host=10.71.20.167 qmd=$(git -C "$here" rev-parse --short HEAD)"
  echo "== qmd update"; /usr/bin/time -p timeout -s KILL "${UPDATE_DEADLINE:-3600}" node "$QMD" update 2>&1 | tail -15
  echo "== qmd embed";  /usr/bin/time -p timeout -s KILL "${EMBED_DEADLINE:-7200}" node "$QMD" embed  2>&1 | tail -15
  echo "== $label end $(date -u +%FT%TZ)"
} 2>&1 | sed -e "s#${QMD_POSTGRES_URL}#<url>#g" | tee "$log"
