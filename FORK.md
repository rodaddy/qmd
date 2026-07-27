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
