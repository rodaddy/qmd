# Postgres backend benchmark — Development collection

Status: RUNNING numbers, measured 2026-08-26 on Rico's Mac mini against the
`general` CNPG cluster at 10.71.20.167 (database `qmd`, halfvec(768), HNSW
m=32 / ef_construction=128), branch `feat/postgres-backend` at 7afa99c,
inference remote on llama-swap. Runner: `scripts/bench-postgres.sh`, librarian
bypassed. Corpus: 1,836 documents, 10,762 chunks (Development only; the
7,180 / 201,478 figures elsewhere are fleet-wide).

## The number that had to be beaten

Incremental `qmd update` + `qmd embed` on Development, SQLite backend,
measured 2026-08-26 before this work (dev#347): **4m13s**, of which 5s was
inference.

## Results

| run | qmd update | qmd embed | total | notes |
|---|---|---|---|---|
| run1, clean full load | `qmd update` 26.97s (1835 new, 1 updated) | `qmd embed` 287.29s (10,762 chunks from 1,774 docs) | 5m14s | first write of the whole collection; row-by-row insert path as merged from PR #375 |
| run2, incremental | `qmd update` 2.49s (1 new, 1835 unchanged) | `qmd embed` 1.45s (17 chunks, 1 doc) | **3.9s** | the comparable run: **4m13s -> 3.9s** |

Logs: `/Volumes/ThunderBolt/Development/.qmd/bench-run1.log`,
`bench-run2.log` (not tracked).

Search through the same backend (`BENCH_STEPS=search`): `qmd search halfvec`
(FTS, to_tsquery OR-terms, ts_rank_cd) and `qmd vsearch "moving the index to
postgres"` (halfvec cosine over HNSW) both return ranked results. That step
took 4m00s wall for the two queries together, unexplained and UNMEASURED per
query; it is the next thing to time.

## Still open

- Full-load embed is 26.7ms/chunk end to end. The split between inference
  and the two-INSERT-per-chunk write path is unmeasured; FORK.md's numbers
  (3ms per committed row, 200x gain from batching) say most of it is writes.
- The 4-minute search step above.
- `bm25()` vs `ts_rank_cd` ranking and OR-vs-AND FTS semantics are recorded
  decisions in FORK.md, not yet reconciled across backends.
