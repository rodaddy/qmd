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
