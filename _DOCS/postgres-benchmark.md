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
| run3, clean full load, batched writes | not run (`BENCH_STEPS=embed`) | `qmd embed` **190.64s** (10,779 chunks from 1,775 docs) | 190.64s | sha def2a8f + batched insert; one multi-row transaction per embed batch. **287.29s -> 190.64s, -96.6s (-34%)**. `select count(*) from vectors` = 10,779 |
| run4, same + `synchronous_commit=off` | not run (`BENCH_STEPS=embed`) | `qmd embed` **187.68s** (10,779 chunks from 1,775 docs) | 187.68s | `QMD_PG_SYNCHRONOUS_COMMIT=off`, verified reaching the session (`SHOW synchronous_commit` -> `off`). 2.96s vs run3 — **within noise, no real gain**. count = 10,779 |

Logs: `/Volumes/ThunderBolt/Development/.qmd/bench-run1.log`,
`bench-run2.log`, `bench-run3.log`, `bench-run4.log` (not tracked).

Chunk count is 10,779 in run3/run4 vs 10,762 in run1 because the collection
itself grew between the two dates, not because of a partial write.

### Where the remaining 190s goes: HNSW index maintenance

Measured directly on two scratch `UNLOGGED` tables, inserting the same 2,000
rows sampled from `vectors`:

| target | insert time |
|---|---|
| table with no vector index | **8.9ms** |
| table with `hnsw (embedding halfvec_cosine_ops) m=32, ef_construction=128` | **4494.7ms** |

A 500x difference, and it is CPU inside the index build rather than I/O — which
is why `synchronous_commit=off` bought nothing in run4. Batching removed the
per-statement round trip through the Atomics bridge (the -96.6s); what remains
is `pgvector` building the HNSW graph on each insert, and no change to the
write SHAPE can reach it. The lever, if the full-load time matters, is to drop
`idx_vectors_embedding_hnsw` before a bulk load and rebuild it after — a
different change against tuned DDL, not attempted here.

Search through the same backend (`BENCH_STEPS=search`): `qmd search halfvec`
(FTS, to_tsquery OR-terms, ts_rank_cd) and `qmd vsearch "moving the index to
postgres"` (halfvec cosine over HNSW) both return ranked results. That step
took 4m00s wall for the two queries together, unexplained and UNMEASURED per
query; it is the next thing to time.

## Still open

- ~~Full-load embed is 26.7ms/chunk end to end; the split between inference
  and the write path is unmeasured.~~ ANSWERED by run3/run4 above. Batching the
  writes returned 96.6s of it; the rest is HNSW index maintenance, not the
  bridge. FORK.md's "200x from batching" held for raw row inserts (8.9ms vs
  ~1,550ms for 500 rows) but does NOT carry to a table with a live HNSW index.
- Bulk-load path: drop and rebuild `idx_vectors_embedding_hnsw` around a full
  embed, instead of maintaining it row by row. Unmeasured; touches tuned DDL.
- The 4-minute search step above.
- `bm25()` vs `ts_rank_cd` ranking and OR-vs-AND FTS semantics are recorded
  decisions in FORK.md, not yet reconciled across backends.
