# Done-means checks — qmd

Executable checks that decide whether a class of change is done. The agent
produces, the script judges, the controller re-runs it. Same exit grammar as
Development (`/Volumes/ThunderBolt/Development/scripts/done-means/README.md`).

| exit | meaning |
| --- | --- |
| `0` | pass |
| `1` | the thing under test failed |
| `3` | harness error — the check could not look. Never a pass, never a fail. |

Rules: one file per class, `#!/usr/bin/env bash`, judge the checkout the
script lives in, no `/tmp`, no secrets. New checks are seen RED before the
change that turns them green; the RED run is recorded on the lane's issue.

| check | proves |
| --- | --- |
| `pg-merge-applies.sh` | upstream PR tobi/qmd#375 is merged: `src/pg.ts` + `src/pg-worker.ts` present, zero conflict markers, driver declared |
| `types-clean.sh` | `npm run test:types` exits 0 |
| `pg-schema-tuned.sh` | the Postgres DDL matches FORK.md's measured configuration (halfvec, HNSW m=32/ef_construction=128, to_tsquery OR-terms, ts_rank_cd; no websearch_to_tsquery) |
| `pg-benchmark-ran.sh` | a benchmark record with `qmd update` and `qmd embed` wall times against the 4m13s baseline exists |
| `pg-bridge-fails-fast.sh` | the Postgres sync bridge throws (within 30s) on an unreachable URL instead of blocking forever in Atomics.wait; contacts no database |
