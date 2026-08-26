# Handoff — qmd Postgres merge lane (2026-08-26)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOFF-BASE.md in full
(181 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read qmd/_DOCS/HANDOFF-RULES.md in full (27 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
- Cluster serving, tuned — RUNNING (`psql -h 10.71.20.167 -U qmd -d qmd -tAc "show shared_buffers"` → `1GB`)
- Corpus loaded by hand, not by qmd — RUNNING (`psql … -tAc "select count(*) from chunks"` → 201478)
- Hybrid query beats sqlite-vec — RUNNING (`psql -qf remote-hybrid.sql` → 15.8-24.7ms warm)
- Baseline to beat — RUNNING (`time qmd update && time qmd embed` → 4m13s, 5s of it inference)
- Inference already remote; that half is DONE — RUNNING (`curl llama-swap.rodaddy.live/v1/models` → 200)
- PR tobi/qmd#375 fetched, clone standing by on `pg-test` — WRITTEN (sha 55328be)
- Merge is NOT clean — WRITTEN (`git merge --no-commit FETCH_HEAD` → 25 hunks, 15 in store.ts; aborted)
- Analysis + two open decisions — MERGED (sha 297d2e3, FORK.md)
- Rest of the program — WRITTEN (dev#347; qmd side in FORK.md)
- Graph mode: **not converted** — RUNNING (`ls qmd/scripts/done-means` → absent)
Re-probe before dispatching anything (live state beats this doc):
- `psql -h 10.71.20.167 -U qmd -d qmd -tAc "select count(*) from chunks"` → expect 201478
- `cd /Volumes/ThunderBolt/_tmp/qmd/_scratch/pgmerge && git status -sb` → expect clean on `pg-test`

## State 2 — LAND THE PAPERWORK
Branch: `feat/postgres-backend` from `origin/main` — cut it if absent; if the
checkout is `main` or `rodaddy/v2.6.3-repo-local` is merged, switch first,
never work there. Work happens in the standby clone, not the live checkout.
Retire: `none` this session. `feat/mcp-2026-07-28` and
`feat/skills-layout-scaffold` are unmerged and NOT this lane's — report them
to Rico, do not delete (the branch-count gate will fire; that is expected).
Commit this handoff: branch `wip/2026-08-24`, path
`_reports/2026-08/handoff-qmd-postgres-merge-20260826.md`, explicit-path
staging, `git commit -F` message file.
Scribe: dev#347 — started: `gh issue create` → issues/347
Done-check: `git log -1 --stat`

## State 3 — graph-mode setup for qmd
Tier: T1 — adds a check harness; no runtime behaviour changes.
Deliverable: `qmd/scripts/done-means/` with one executable check per claim
class this lane needs (merge applies, suite green, benchmark ran).
Scope: `qmd/scripts/done-means/`, `qmd/_DOCS/`.
Must NOT: touch `src/`, run the merge, or modify the live checkout.
Record: dev#347
Done-check: `ls qmd/scripts/done-means/*.sh | wc -l` → ≥1 (RED: not yet run)

## State 4 — merge PR #375 into the standby clone
Tier: T2 — replaces the storage layer; 25 conflict hunks across 8 files.
Deliverable: `pg-test` in the temp clone with #375 merged, conflicts resolved,
`npm run test:types` clean.
Scope: `/Volumes/ThunderBolt/_tmp/qmd/_scratch/pgmerge` ONLY.
Must NOT: touch `/Volumes/ThunderBolt/Development/qmd`. Resolve a conflict by
deleting our fork's patches (array pattern, remote-model fix) — those are why
the fork exists.
Record: dev#347
Done-check: `npm run test:types` → exit 0 (RED: not yet run)

## State 5 — patch schema to the measured configuration
Tier: T1 — changes only the Postgres DDL the merged branch emits.
Deliverable: DDL emits `halfvec(768)`, HNSW `m=32, ef_construction=128`,
`to_tsquery` OR-terms, `ts_rank_cd`. Evidence per row is in FORK.md.
Scope: the merged `src/pg.ts` and `src/store.ts` Postgres branch, in the clone.
Must NOT: change SQLite behaviour or leave `websearch_to_tsquery` in place —
it ANDs terms and returns silent zeros.
Record: dev#347
Done-check: `rg -c 'halfvec|ts_rank_cd|to_tsquery' src/store.ts` → ≥3 (RED: not yet run)

## State 6 — run the real benchmark against 4m13s
Tier: T2 — first time qmd writes to the shared cluster.
Deliverable: timed `qmd update` + `qmd embed` on Development through the
merged branch against `10.71.20.167`, both numbers recorded on dev#347.
Scope: the clone, the `qmd` database, a COPY of Development's `.qmd/index.yml`.
Must NOT: point the live librarian at it, or overwrite Development's own
sqlite index (see HANDOFF-RULES rule 4 — this already happened once).
Record: dev#347
Done-check: `qmd update && qmd embed` → wall time recorded vs 4m13s (RED: not yet run)

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Does qmd's FTS OR or AND its terms? Needs Rico. Detail: qmd/FORK.md.
- `bm25()` vs `ts_rank_cd` rank differently — pick one and write it down. Detail: qmd/FORK.md.
- Atomics-bridge per-query overhead is UNVERIFIED; nothing has run through it.
- Whether the PR's row-by-row write (200x slower than batched) is fixed in
  this lane or a follow-up — decide after State 6's number. Detail: dev#347.
- `qmd mcp --http` is unsafe under the Postgres backend; unused here, unswept
  on the fleet. Detail: qmd/FORK.md.
- rtech-infra holds `max_wal_size` 4GB unapplied, waiting on a checkpoint
  count from State 6.
