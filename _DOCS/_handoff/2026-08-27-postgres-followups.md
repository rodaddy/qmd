# Handoff — qmd Postgres cutover, first repos through the librarian (2026-08-27)

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
- PR rodaddy/qmd#5 open, feat/postgres-backend → rodaddy/v2.6.3-repo-local, one review round done, merge is Rico's — WRITTEN (`gh pr view 5 --repo rodaddy/qmd --json state` → OPEN, HEAD 5c73035 or later)
- Development through Postgres: incremental update+embed 3.9s vs 4m13s; clean full embed 190.64s of which the write path is under 3s, the rest remote inference at ~17ms/chunk serial — RUNNING (_DOCS/postgres-benchmark.md, sha c9aa2f9; fixes 5c73035)
- Exit hang fixed, search exits in 0s under the bridge — RUNNING (`/Volumes/ThunderBolt/_tmp/qmd/_scratch/search-exit-probe.sh search halfvec -n 1` → rc=0)
- Cluster holds Development only: 1 collection, 10,779 vectors — RUNNING (`psql -h 10.71.20.167 -U qmd -d qmd -tAc "select collection,count(*) from documents group by 1"` → Development|1836)
- Live librarian still runs the installed SQLite qmd on 127.0.0.1:7141; scribe-emit timed out twice at 02:58 local — RUNNING (`~/Library/Logs/exemplar-librarian.err.log`)
- Cutover target from Rico 2026-08-26: one database, one collection per repo, store_collections replaces per-repo index.yml, librarian is the single writer and main reader, aqmd sends cwd+query, later 2-4 replicas on k3s — PROPOSED (dev#347 comment 5421746940)
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh | wc -l` → 5, all rc=0 at 5c73035)
Re-probe before dispatching anything (live state beats this doc):
- `git status -sb && git log --oneline -1` → clean on `feat/postgres-backend`
- `curl -s -m 3 127.0.0.1:7141/health` → the librarian answers, or say it does not

## State 2 — LAND THE PAPERWORK
Branch: `feat/postgres-backend` from `origin/main` — cut it if absent; if the
checkout is `main` or PR #5 is merged, cut `feat/librarian-postgres` from
`rodaddy/v2.6.3-repo-local` instead, never work on either.
Retire: `none`. `feat/mcp-2026-07-28` and `feat/skills-layout-scaffold` are
unmerged and not this lane's — report, do not delete.
Commit this handoff: branch `feat/postgres-backend`, path
`_DOCS/_handoff/2026-08-27-postgres-followups.md`, explicit-path staging,
`git commit -F` message file.
Scribe: dev#347 — started: `scribe-emit --repo rodaddy/development --kind note --issue 347 --state RUNNING --summary "<lane start>"`; if it times out, `gh issue comment 347` with the signature line
Done-check: `git log -1 --stat`

## State 3 — librarian resolves cwd to a collection and reads Postgres
Tier: T2 — changes the live librarian on this Mac; every aqmd call goes through it.
Deliverable: the librarian (source: `rg -l exemplar-librarian /Volumes/ThunderBolt/Development/_ob`)
runs qmd with QMD_BACKEND=postgres and the URL from Vaultwarden, maps the
caller's cwd to a store_collections row by longest path prefix, and passes
`-c <collection>` on every query. A cwd with no row answers "no collection"
instead of fleet-wide recall. Development is the only row today.
Scope: the librarian source and its launchd plist, `_ob/bin/aqmd`.
Must NOT: touch the 56 per-repo .qmd files; write to the cluster from more
than one process; put the URL in any file (env from Vaultwarden at start).
Record: dev#347
Done-check: `cd /Volumes/ThunderBolt/Development && aqmd "postgres benchmark" | head -3` → hits from collection Development, and from `cd qmd` the same query answers "no collection" (RED: not yet run)

## State 4 — second repo through the librarian, no index.yml
Tier: T2 — first write to the cluster by the librarian itself.
Deliverable: `qmd` added as a collection by the librarian
(`qmd collection add /Volumes/ThunderBolt/Development/qmd --name qmd --mask`
taken from qmd/.qmd/index.yml), update+embed run by the librarian, the
repo's .qmd/index.yml left in place but unused; wall time recorded in
_DOCS/postgres-benchmark.md.
Scope: the librarian, the cluster's qmd-owned tables.
Must NOT: delete qmd/.qmd/*; run update/embed from a shell outside the
librarian; touch tables chunks, docs, wtest.
Record: dev#347
Done-check: `psql … -tAc "select collection,count(*) from documents group by 1"` → two rows, qmd > 0, and `cd qmd && aqmd "halfvec"` answers from collection qmd (RED: not yet run)

## State 5 — inference throughput on a full embed
Tier: T1 — measurement first; a code change only if the GPU shows idle time.
Deliverable: the llama-swap embedding endpoint under 2 and 4 concurrent
embedBatch requests on the State 4 load: wall time and GPU utilisation from
the GPU box, recorded. Rico's standing ruling: one GPU, already pinned, so a
concurrency change lands only if the measurement shows idle GPU time.
Scope: `src/remote-llm.ts`, `src/store.ts` embed loop, _DOCS/postgres-benchmark.md.
Must NOT: change batch size or concurrency defaults without the receipt.
Record: dev#347
Done-check: `rg -c 'concurrency=(2|4)' _DOCS/postgres-benchmark.md` → 2, each row with wall time and GPU util (RED: not yet run)

## State FINAL — WRAP
Invoke the handoff-author skill; next handoff passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- FTS OR-terms and ts_rank_cd are in PR #5 as decisions awaiting Rico's ratification. Detail: qmd/FORK.md.
- Collection naming across 56 repos: repo directory name, unique under Development; nested repos unresolved. Detail: dev#347.
- `qmd mcp --http` is unsafe under the Atomics bridge; unswept on the fleet. Detail: qmd/FORK.md.
- rtech-infra max_wal_size 4GB waits on the checkpoint count: 7 requested during a 5m14s full load.
- The librarian on k3s (replicas, ingress, sources via /mnt/collab) is the target after the Mac cutover; not sliced here.
