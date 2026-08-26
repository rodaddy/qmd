# Handoff — qmd Postgres backend follow-ups (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read qmd/_DOCS/HANDOFF-RULES.md in full (52 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
Work happens in /Volumes/ThunderBolt/Development/qmd, never a clone (Rico
ruling 2026-08-26). Program: dev#347; qmd-side detail in FORK.md.
- PR tobi/qmd#375 merged onto the fork with tuned DDL, bridge fail-fast,
  schema parity, SQLite-only statements branched — WRITTEN (`git log --oneline origin/rodaddy/v2.6.3-repo-local..feat/postgres-backend` → 12 commits, pushed)
- Benchmark on Development through Postgres: incremental update+embed 3.9s vs
  4m13s; clean full load 5m14s (embed 287s / 10,762 chunks) — RUNNING (_DOCS/postgres-benchmark.md, sha 8f923dc)
- FTS search and vsearch answer through Postgres; the two-query search step
  took 4m00s wall, unmeasured per query — RUNNING (`BENCH_STEPS=search scripts/bench-postgres.sh /Volumes/ThunderBolt/Development s1`)
- Cluster holds Development's index: 1,835 documents, 10,762 vectors, halfvec(768), HNSW m=32/ef_construction=128 — RUNNING (`psql -h 10.71.20.167 -U qmd -d qmd -tAc "select count(*) from vectors"` → 10762)
- Checkpoints during the full load: pg_stat_checkpointer num_requested=7, num_timed=52 since 01:47Z — RUNNING (`psql … -tAc "select num_timed,num_requested from pg_stat_checkpointer"` → 52|7; for rtech-infra's max_wal_size decision)
- Unit suite on the branch — UNVERIFIED (`npm run test:unit` not run since the merge; 9 known cli.test.ts failures on clean upstream, FORK.md)
- Live librarian still runs the installed SQLite qmd; nothing points at the cluster yet — RUNNING (`~/Library/Logs/exemplar-librarian.err.log` embed:Development 01:39)
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh | wc -l` → 5, all green at 8f923dc)
Re-probe before dispatching anything (live state beats this doc):
- `cd /Volumes/ThunderBolt/Development/qmd && git status -sb && git log --oneline -1` → clean on `feat/postgres-backend` at 8f923dc or later
- `PGPASSFILE=<vaultwarden> psql -h 10.71.20.167 -U qmd -d qmd -tAc "select count(*) from vectors"` → 10762

## State 2 — LAND THE PAPERWORK
Branch: `feat/postgres-backend` from `origin/main` — cut it if absent; if the
checkout is `main` or `feat/postgres-backend` is merged (PR to
rodaddy/v2.6.3-repo-local), switch first, never work there.
Retire: `none`. `feat/mcp-2026-07-28` and `feat/skills-layout-scaffold` are
unmerged and not this lane's — report, do not delete.
Commit this handoff: branch `feat/postgres-backend`, path
`_DOCS/_handoff/2026-08-27-postgres-followups.md`, explicit-path staging,
`git commit -F` message file.
Scribe: dev#347 — started: `scribe-emit --repo rodaddy/development --kind note --issue 347 --state RUNNING --summary "<lane start>"`
Done-check: `git log -1 --stat`

## State 3 — unit suite on the merged branch
Tier: T1 — shared code; a broken sqlite path would ship in the PR.
Deliverable: `npm run test:unit` result on `feat/postgres-backend` with every
failure classified: known (FORK.md's 9 cli.test.ts) or new; new ones fixed.
Scope: `src/`, `test/`.
Must NOT: mark a new failure as known; run any qmd command against a database.
Record: dev#347
Done-check: `npm run test:unit 2>&1 | tail -3` → only the 9 known failures (RED: not yet run)

## State 4 — batch the Postgres embed write path
Tier: T1 — changes only the Postgres branch of insertEmbedding.
Deliverable: embeddings written in multi-row statements inside one
transaction per batch; FORK.md measured 500 rows 7.7ms batched vs 1,550ms
row-by-row. Measure the inference/write split first and write both numbers
into _DOCS/postgres-benchmark.md.
Scope: `src/store.ts` insertEmbedding and its embed-loop caller, `src/pg.ts`.
Must NOT: change SQLite behaviour; change DDL; touch tables chunks/docs/wtest.
Record: dev#347
Done-check: drop qmd's seven tables, `scripts/bench-postgres.sh /Volumes/ThunderBolt/Development run3` → embed under 287s (RED: 8f923dc, 287.29s)

## State 5 — time search, vsearch and query per step
Tier: T1 — read path only.
Deliverable: wall time per query for `search`, `vsearch`, `query` through
Postgres on Development, with the slow step named (FTS, HNSW, rerank,
expansion) and fixed if it is in qmd's Postgres branch.
Scope: `scripts/bench-postgres.sh` search step, `src/store.ts` search paths.
Must NOT: change ranking semantics (bm25 vs ts_rank_cd is Rico's decision).
Record: dev#347
Done-check: `BENCH_STEPS=search scripts/bench-postgres.sh /Volumes/ThunderBolt/Development s2` → each query under 30s, numbers in _DOCS/postgres-benchmark.md (RED: 8f923dc, 4m00s for two queries)

## State 6 — PR to the fork's working branch
Tier: T1 — merges into rodaddy/v2.6.3-repo-local; no deploy.
Deliverable: PR feat/postgres-backend → rodaddy/v2.6.3-repo-local on
github.com/rodaddy/qmd, body per pr-scribe, ONE review round (Light), fixes
applied, FORK.md patch table updated with the Postgres backend row.
Scope: PR, `FORK.md`.
Must NOT: merge without Rico's explicit approval; open a second review round.
Record: dev#347
Done-check: `gh pr view --repo rodaddy/qmd --json state,reviewDecision` → OPEN with one review posted (RED: not yet run)

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- FTS semantics: the branch ORs terms (to_tsquery) to match FTS5; ranking is ts_rank_cd. Both need Rico's ratification. Detail: qmd/FORK.md.
- Cutover of the live librarian and the fleet's 56 indexes to the cluster is unplanned. Detail: dev#347.
- `qmd mcp --http` is unsafe under the Atomics bridge; unswept on the fleet. Detail: qmd/FORK.md.
- rtech-infra's max_wal_size 4GB change waits on the checkpoint count above (7 requested during a 5m14s full load).
- Full-load embed split inference vs writes is unmeasured; State 4 measures it.
