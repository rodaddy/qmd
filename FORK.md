# Fork Notes — rodaddy/qmd

Upstream: https://github.com/tobi/qmd
Fork:     https://github.com/rodaddy/qmd
Active branch: `rodaddy/v2.6.3-repo-local` (forked from upstream `e428df7`, v2.6.3)

## Why this file exists

In April 2026 this fork sat on `fix/skip-missing-collection-dirs` and drifted
**124 commits** behind upstream. When the time came to rebase, nobody could say
which local patches were still needed or why. One of the two turned out to have
been fixed upstream months earlier; the other was still required. Working that
out meant reading diffs commit by commit.

Every local change goes in the table below **when it is made**, with the reason
and a test that proves whether it is still needed. On the next upstream rebase,
run down the list: if the test passes without the patch, drop the patch.

## Local patches

| # | Change | Files | Why | Still needed if… |
|---|---|---|---|---|
| 1 | Skip missing collection directories during `update` | `src/cli/qmd.ts` (`updateCollections`) | A collection whose directory is gone (unmounted volume, deleted clone) aborted the whole update, taking every later collection with it. Upstream still has no guard. | `qmd update` with one collection pointing at a nonexistent path aborts instead of warning and continuing. |
| 2 | `-c/--collection` on `update` | `src/cli/qmd.ts` (`updateCollections`, dispatch, help) | `update` walked every collection unconditionally: 30s–4min on a machine with ~36 collections, nearly all of it other repos. Scoped is sub-second. `embed` already accepted `-c`; this makes the pair symmetrical. | `qmd update -c <name>` is rejected or silently updates everything. |
| 3 | `pattern` accepts `string[]` (allowlist) | `src/collections.ts`, `src/store.ts`, `src/index.ts` | See "Patch 3" below — this is the load-bearing one. | `pattern:` in a collection config rejects a YAML array, or an array is stored/read back as `[object Object]`. |
| 4 | `qmd update <path>...` (positional file paths) | `src/cli/qmd.ts` (`updatePaths`, dispatch, help), `src/store.ts` (`reindexDocument`, `reindexPaths`) | Patch 2 scoped `update` to a collection; this scopes it to a file. Re-globbing a whole tree because one file changed is all waste, and an agent that just wrote a file wants that one doc searchable now. Reuses the same per-file indexing path as the collection walk, so add/update/skip semantics cannot drift. | `qmd update <file>` is rejected, walks the whole collection anyway, or a path outside every collection root fails without naming the roots. |
| 5 | Remote OpenAI-compatible backend for embed/rerank/generate | `src/remote-llm.ts` (new), `src/llm.ts` (`LLM` interface, `getDefaultLlamaCpp`), `src/store.ts` (`getLlm`, `searchVec`), `src/cli/qmd.ts` (`getStore`) | Embedding ran in-process only, pinning it to the machine running qmd. Worse, a `models.embed` naming a URL was accepted and silently ignored -- a dead port on a fake path still returned full results. | `models.embed: http://host:8080/v1#model` embeds locally instead of POSTing to that server, or an unreachable backend returns results rather than an error. |

## Patch 3 — why an array pattern is required

qmd 2.6.3 filters indexing on three things only: the glob `pattern`, a hardcoded
six-entry directory list (`store.ts` — `node_modules .git .cache vendor dist
build`), and per-collection `ignore:` globs.

Note that **2.6.3 removed `.gitignore` support** that 2.1.0 had
(`loadGitignoreMatchers`). Upgrading silently removed the filtering many repos
were relying on. That is upstream's change, not ours, but it is what makes this
patch necessary.

A blocklist cannot express what needs excluding here. In a repo that vendors
other git repos, one directory holds both:

```
ai-agents/platforms   42 tracked files   89,433 files on disk
ai-agents/agents      22 tracked files  252,494 files on disk
```

Four blocklist approaches were tried and measured. Real answer: ~413 files.

| Approach | Files still indexed | Why it failed |
|---|---|---|
| Translate `.gitignore` → globs | 38,568 | The bulk was never *in* `.gitignore`. `agents/skippy_hermes` is 166,671 files, 0 tracked, and unignored. |
| Exclude untracked top-level dirs | 38,568 | Also dropped `_DOCS/`, which we want, and missed `agents/`/`platforms/` because each holds a few tracked files. |
| `git check-ignore` | — | Flags none of the vendor trees. |
| Exclude nested `.git` dirs | — | `agents/skippy_hermes` is a plain directory, not a checkout. |

Inverting to an allowlist — deny everything, admit named directories — fixes it,
the same shape as `/Volumes/ThunderBolt/Development/.gitignore` (`*` then `!`
exceptions). Anything unanticipated is excluded by default rather than swallowed.

Two rules make it correct:

1. Each allowlisted directory contributes **only its own files** — no `/**/`.
   With recursion, one tracked file inside `platforms/` readmits all 89,433.
2. The directory list comes from `git ls-files`. Git already knows what belongs.

Measured with the allowlist:

| Repo | Indexed | Tracked |
|---|---|---|
| ai-agents | 413 | (121,415 unfiltered) |
| rtech-mcps | 1,761 | 1,763 |
| rtech-infra | 612 | 619 |
| rtech-agents | 294 | 288 |
| mcp2cli | 257 | 256 |
| aiHustle | 195 | 191 |

### Why not a single brace-expanded string instead

A single `{dirA,dirB,…}/*.{ts,py,…}` string needs no fork at all, which is
genuinely attractive. It was tested and **it does not scale**.

| Directories | Result |
|---|---|
| 50 | 164 files, fine |
| 100 | 381 files, fine |
| 200 | 838 files, fine |
| **346** (rtech-mcps) | **fails** |

The cause is not Bun and not fast-glob. It is the `braces` library fast-glob
expands with, which enforces a hard input ceiling. Node reports it plainly:

```
SyntaxError: Input length (14405), exceeds max characters (10000)
```

Bun hits the same limit but crashes rather than throwing, which is why this
first looked like a runtime bug. Both runtimes fail at the same place.

An array avoids it because each element is expanded on its own, so no single
input approaches the ceiling. The single-string form works until a repo grows
past ~200 source directories and then fails hard — a landmine, not a fix. Hence
the fork.

## Rebasing onto a newer upstream

1. `git fetch upstream && git log --oneline <current>..upstream/main`
2. For each patch above, run its "still needed if…" test against clean upstream.
   Drop anything upstream has fixed — patch 2's ancestor was carried for months
   after it stopped being necessary.
3. Rebase what remains, re-run `npm run test:types` and `npm run test:unit`.
4. Update this file in the same commit.

### Known pre-existing test failures

`npm run test:unit` reports **9 failures in `test/cli.test.ts`** on clean
upstream v2.6.3, unrelated to any local patch. They assert an empty stderr, and
Node v26 emits `DeprecationWarning: module.register()`. Verified by stashing all
local changes and re-running. Do not treat these as fork breakage.

## Install

The package is scoped upstream (`@tobilu/qmd`), so a `bun add` lands in
`~/node_modules/@tobilu/qmd` and leaves any older unscoped `~/node_modules/qmd`
in place. `~/.local/bin/qmd` prefers the scoped path for that reason; without it
the wrapper silently keeps running the stale copy and `qmd --version` reports the
old version after a successful upgrade.

```sh
cd ~ && bun add /Volumes/ThunderBolt/Development/qmd --no-scripts
```

`--no-scripts` skips the `better-sqlite3` native build, which fails under
node-gyp here and is unused: `db.ts` picks `bun:sqlite` when running under Bun
and only falls back to `better-sqlite3` under Node.

## Known defects, not yet fixed

Filed here rather than as GitHub issues: issues are disabled on
`rodaddy/qmd`, and `gh` in this checkout resolves to upstream `tobi/qmd`,
where these would land on someone else's tracker.

Found 2026-08-25 by the rtech-infra seat while researching whether repeated
llama-swap calls could be cached; confirmed against source by the qmd seat.
Both are upstream defects, present in clean v2.6.3, not fork breakage.

### D1 — `llm_cache` self-evicts before it can hit

`setCachedResult` (`src/store.ts`) trims to the newest 1000 rows on ~1% of
writes. The rerank path calls it inside a loop over `rerankResult.results`,
so it writes ONE ROW PER DOCUMENT per search: a search over 100 chunks
writes 100 rows, and roughly 10 searches turn the whole cache over.

Live evidence: `SELECT COUNT(*) FROM llm_cache` on the Development index
returns 0 rows, with `min(created_at)` and `max(created_at)` both NULL,
after months of use.

Still needed if: the cap is still a fixed row count sized against writes
per REQUEST rather than writes per SEARCH.

### D2 — rerank cache keys record the requested model, not the serving one

`rerank()` (`src/store.ts`) declares `model: string = DEFAULT_RERANK_MODEL`,
the `hf:` constant. The cache key is built from that parameter, so a caller
that omits it keys the entry under `hf:...` no matter which backend actually
produced the score. With a remote backend configured, a score computed on
llama-swap is cached under the local model's name and vice versa.

Note the key is NOT missing model identity — `model` is in the hashed body,
and the literal `"rerank"` passed as the url argument is cosmetic. The defect
is what the parameter RESOLVES to.

Same class as the `wireModel()` bug fixed in `src/remote-llm.ts`, where a
caller's `hf:` default reaching the server produced "no router for requested
model" 404s. Both come from a caller-side default standing in for the
backend's real identity.

Still needed if: the cache key derives from the `model` PARAMETER rather
than from the resolved backend identity.

### Fixing these

Measure before sizing. A hit/miss counter in `getCachedResult`, surfaced in
search output, establishes the real repeat rate as a side effect of normal
use — the byte-identical repeat rate is currently UNMEASURED, and sizing a
cache against a guessed hit rate is how the 1000-row cap got chosen.

Invalidation rules that must hold for any replacement key:

- Full model identity: resolved backend URL AND model name (D2).
- `embed_fingerprint` for embeddings; context size and rerank token budget
  for rerank — the reranker moved to `-c 8192 -b 4096 -ub 4096` on
  2026-08-25, which silently invalidates any score stored before it.
- The intent-prefixed `rerankQuery`, not the raw query. Current code is
  already correct here.
- Never key an embedding on unformatted text: `formatQueryForEmbedding` and
  `formatDocForEmbedding` apply task prefixes that must not collide.
- A cache version bumped on any chunking or prompt-format change.

Out of scope for the engine: `cache_prompt`, `--cache-reuse`, and
`--slot-save-path` are documented only under llama-server's `/completion`
endpoint. Neither `/v1/embeddings` nor `/rerank` supports prefix reuse, and
llama-swap adds no response cache, so this has to be solved in qmd.

### D3 — a list-shaped `collections:` block indexes but cannot be searched

`.qmd/index.yml` expects `collections:` to be a MAP keyed by collection
name, with an absolute `path:` and a `pattern:` list:

```yaml
collections:
  mycorpus:
    path: /abs/path/to/docs
    pattern:
      - "*.md"
```

The list-of-objects spelling — the more common YAML idiom, and what a
reasonable person writes from memory — is ACCEPTED by the loader:

```yaml
collections:
  - name: mycorpus
    path: docs
    include:
      - "**/*.md"
```

Measured 2026-08-25 on a 67-file corpus: `qmd update` reported
`Indexed: 67 new`, `qmd embed` embedded 448 chunks, `documents`,
`content`, and `documents_fts` each held 67 rows, and `content_vectors`
held 448 under the correct model and fingerprint. Every query — `qmd
query`, `qmd vsearch`, and plain `qmd search` — returned
`No results found`.

Lexical search failing alongside vector search is what rules out an
embedding problem: the documents are indexed under paths that cannot be
resolved at search time.

The cost is that every observable signal reports success. No error, no
warning, and every row count is correct.

Still needed if: the config loader accepts a list under `collections:`
without either rejecting it or normalizing it to the map form.

Worth fixing at the loader rather than in the docs. This is the same
class as the `embed:` field accepting a URL and silently ignoring it —
the defect this fork exists to fix. A config value that is accepted,
acted on, and produces a working-looking artifact that cannot serve its
purpose is harder to debug than one that is rejected outright.

## Postgres backend — decisions that must be made deliberately

Status: ANALYSED, nothing merged. Upstream PR tobi/qmd#375 (chrisdietr,
1,006 additions across 12 files) implements an opt-in PostgreSQL +
pgvector backend via `QMD_BACKEND=postgres` and `QMD_POSTGRES_URL`. It
was closed 2026-05-20 in a backlog sweep with a form message — "over two
months old and has either been superseded or is too stale to keep
actionable" — not on any recorded technical objection. Its predecessor
#342 was closed by the author in favour of #375.

Closed-in-a-sweep is not rejected, and it is also not review. No
maintainer vouched for this code.

### It keeps the synchronous API

`src/pg-worker.ts` runs the async `postgres` driver inside a
`worker_threads` Worker. The main thread posts a query and blocks on a
`SharedArrayBuffer` via `Atomics.wait` until the worker signals with
`Atomics.notify`. The pool is `max: 1`, explicitly "matching synchronous
caller semantics."

So `store.ts` keeps calling `.get()` / `.all()` / `.run()` synchronously
and none of its 134 sync call sites move. An earlier reading of this
fork concluded a Postgres backend required converting 97 sync exports to
async and propagating `await` through 16 import sites. That was wrong,
and it was wrong in the direction that makes the work look five times
larger than it is.

### Two things are decisions, not tuning values

**1. Does qmd's full-text search OR or AND its terms?**

The PR uses `websearch_to_tsquery`, which ANDs unquoted terms. SQLite
FTS5 as this fork calls it does not. Measured 2026-08-25 across 15
probes on the same corpus: two returned 0 and 1 hits under
`websearch_to_tsquery` where FTS5 returned 10. `reranker batch size
ubatch` requires all four words in one document.

The failure is a silent empty result — no error, no warning, and
indistinguishable to the user from "there is nothing to find." Matching
FTS5's behaviour needs the explicit OR spelling via `to_tsquery`, which
costs more because it scans more of the GIN index (19-29ms against
1.5-3.6ms, measured).

Whichever is chosen, write it down here. "It depends on `QMD_BACKEND`"
produces a bug report nobody can reproduce.

**2. `bm25()` and `ts_rank_cd` rank differently.**

SQLite ranks with `bm25()`. The PR uses `ts_rank`; this fork's
measurements used `ts_rank_cd`, which weights term proximity. All three
order results differently. Supporting both backends means maintaining
two ranking behaviours or accepting that results change with the
backend. Neither is wrong; leaving it undecided is.

### A latent defect the backend swap would expose

`src/mcp/server.ts` line 809:

```
// Session map: each client gets its own McpServer + Transport pair (MCP
// spec requirement). The store is shared — it's stateless SQLite, safe
// for concurrent access.
```

True for `better-sqlite3`: calls are synchronous, so a handler finishes
its query before yielding and concurrent sessions interleave safely.

False under the Atomics bridge, and in a worse way than serialization.
`Atomics.wait` blocks the calling thread, which is the main thread,
which is the event loop. While one MCP session's query is in flight
every other handler is frozen rather than queued, the HTTP server
accepts nothing, and health checks do not answer. With `max: 1` that is
one query at a time across all sessions.

This does not affect the librarian, which spawns qmd as a CLI
subprocess — its `executor.py` opens with "The only module that runs
qmd. One child process at a time, ever." It affects anyone running
`qmd mcp --http`, which is the shared multi-agent deployment the PR was
written for.

The comment is the defect's whole surface. It is correct today, becomes
false after a backend swap, and nothing fails when it does — it will not
error, it will just be wrong. A comment cannot fail a test. If the
backend lands, the fix is something executable, not an edited comment.

### The write path is row-by-row

`insertEmbedding()` in the PR issues two INSERTs per embedding — one to
`vectors`, one to `content_vectors` — and calls `db.prepare()` on both
inside the function, so every embedding re-prepares two statements. No
COPY, no multi-row VALUES, no batching.

Measured 2026-08-26 against a real cluster:

| operation | time |
|---|---|
| single-row INSERT, committed, `halfvec(768)` | 3.04 ms |
| 500 rows in one statement | 7.7 ms |
| same 500 rows row-by-row | ~1,550 ms |

**The 3ms is fsync, not network.** The same INSERT measured 3.18ms
in-cluster and 3.04ms across a LAN hop — within 5%. With
`synchronous_commit=off` it drops to 0.45ms from the same client.

That matters for a reason worth stating: the write cost is not a
consequence of the database being remote. The same code committing per
row against a local Postgres pays the same 3ms. Batching is the fix in
either topology, and `synchronous_commit=off` only makes a bad write
pattern survivable rather than fixing it.

### Tuning the PR does not carry

Measured on the same corpus and cluster. The PR's schema is the untuned
baseline; these are what this fork's measurements arrived at.

| | PR #375 | measured better | evidence |
|---|---|---|---|
| vector type | `vector(768)` | `halfvec(768)` | table 1398→394 MB, index 570→296 MB, 26% faster, **identical recall** (83.60% both, same run, float32-exact ground truth) |
| HNSW params | defaults (m=16, ef_c=64) | `m=32, ef_construction=128` | recall 84.8% → 87.6% for 11 MB |
| FTS parser | `websearch_to_tsquery` | `to_tsquery` OR-terms | see decision 1 above — this one is not tuning |
| ranking | `ts_rank` | `ts_rank_cd` | see decision 2 above |

Absolute recall percentages moved between 83% and 93% across runs
depending on probe sample and cache state. What is solid is the
comparison within a single run against the same ground truth. Do not
quote the absolute number.
