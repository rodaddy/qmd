# Handover — qmd Bun leg, abort-retry pass, index allowlist (2026-08-28)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read qmd/_DOCS/HANDOVER-RULES.md in full (82 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
Work happens in /Volumes/ThunderBolt/Development/qmd, never a clone. Run
`qmd`/`aqmd` from /Volumes/ThunderBolt/Development (rules 4 and 9). Forge is
Forgejo `rodaddy/qmd` (origin). API helper (keychain credential):
`/Volumes/ThunderBolt/_tmp/development/_scratch/forgejo-api.sh <METHOD> <path> [json-file]`.
- PR rodaddy/qmd#9 open, `fix/embed-abort-exit` (c3ff85a) → `rodaddy/v2.6.3-repo-local`; merge is Rico's — WRITTEN (`forgejo-api.sh GET repos/rodaddy/qmd/pulls/9 | jq .state` → open)
- qmd#4 and qmd#5 closed with done-check receipts; qmd#6, #7, #8 open — RUNNING (`forgejo-api.sh GET 'repos/rodaddy/qmd/issues?state=open' | jq length` → 4, one of them PR #9)
- Suite at c3ff85a under the keg: Vitest leg 887 passed | 73 skipped | 0 failed; package smoke exit 0; Bun leg 2 fail (qmd#8) — RUNNING (`/Volumes/ThunderBolt/_tmp/qmd/_scratch/test-all-c3ff85a.log:973-1013`)
- Local branch `chore/index-allowlist-handover` (3c4d725, one file `.qmd/index.yml`) is unmerged with no PR; it is qmd#6's fix from the prior session — WRITTEN (`git log --oneline rodaddy/v2.6.3-repo-local..chore/index-allowlist-handover` → 1 commit)
- Runtime is the node@24 keg; better-sqlite3 built for ABI 137 — RUNNING (`env -u QMD_FORCE_CPU /opt/homebrew/opt/node@24/bin/node scripts/test-all.mjs` typecheck and Vitest legs green at c3ff85a)
- llama-swap endpoint answers — RUNNING (`curl -s -o /dev/null -w '%{http_code}' https://llama-swap.rodaddy.live/v1/models` → 200); its pod is no longer listed in k3s namespace `ai` (`kubectl -n ai get pod` shows no llama-swap row); where it runs now and rtech-infra#1213's state — UNVERIFIED
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh | wc -l` → 5)
Re-probe before dispatching anything (live state beats this doc):
- `git status -sb && git log --oneline -1` → `fix/embed-abort-exit` at c3ff85a or later, clean
- `forgejo-api.sh GET repos/rodaddy/qmd/pulls/9 | jq .state` → open, else State 2 cuts from `rodaddy/v2.6.3-repo-local`
- `curl -s -o /dev/null -w '%{http_code}' https://llama-swap.rodaddy.live/v1/models` → 200 (no lane here embeds, but qmd#7 tests must not either)

## State 2 — LAND THE PAPERWORK
Branch: `fix/bun-leg-and-abort-retry` from `origin/main` is WRONG for this
fork — cut it from `fix/embed-abort-exit` while PR #9 is open (State 4 builds
on `EmbedResult.aborted`), or from `rodaddy/v2.6.3-repo-local` once PR #9 is
merged; if the checkout is `main` or `rodaddy/v2.6.3-repo-local`, switch first,
never work there.
Commit this handover: branch `fix/bun-leg-and-abort-retry`, path
`_DOCS/_handover/2026-08-28-bun-leg-abort-retry-and-index.md`, explicit-path
staging, `git commit -F` message file.
Scribe: rodaddy/qmd PR #9 (Forgejo) — started: `forgejo-api.sh POST repos/rodaddy/qmd/issues/9/comments <json-file with {"body":"**agent:** session started from handover <sha>; work branch <name>"}>`; lane receipts go to the issue each lane names.
Done-check: `git log -1 --stat`

## State 3 — Bun leg green again (qmd#8)
Tier: T1 — the Bun leg gates `scripts/test-all.mjs` for every lane in this repo.
Deliverable: `test/pg-bridge-timeout.test.ts` no longer throws `vi.importActual is not a function` under `bun test --preload ./src/test-preload.ts`: either skip the describe when `typeof Bun !== "undefined"` with a one-line comment naming qmd#8, or give the preload a working `importActual`; Vitest coverage of the file unchanged.
Scope: test/pg-bridge-timeout.test.ts, src/test-preload.ts.
Must NOT: touch src/pg.ts, weaken the two poisoning assertions under Vitest, change other tests.
Record: qmd#8
Done-check: `env -u QMD_FORCE_CPU /opt/homebrew/opt/node@24/bin/node scripts/test-all.mjs` → all four legs pass, `EXIT=0` (RED: c3ff85a, `/Volumes/ThunderBolt/_tmp/qmd/_scratch/test-all-c3ff85a.log:991-1013`)

## State 4 — abort stops work and keeps its reason (qmd#7)
Tier: T1 — shared embed path; changes how many calls a failing backend receives.
Deliverable: in `src/store.ts` `generateEmbeddings`, when the error-rate abort fired, the trailing `retryFailedChunks(true)` skips the chunks the abort wrote off, and their failure reason stays `embedding aborted because error rate was too high` in `EmbedResult.failures`; the store test from 18c2da9 (`generateEmbeddings reports aborted when the error rate trips the abort`) gains the reason assertion and an upper bound on `embedBatch`/`embed` call counts.
Scope: src/store.ts (`retryFailedChunks`, `recordFailure`, the abort branch), test/store.test.ts (that one test).
Must NOT: change the 80% threshold, `BATCH_SIZE`, `MAX_RETRY_ATTEMPTS`, the warn text, the session-expired branch, or run `qmd embed` against any real index.
Record: qmd#7
Done-check: `env -u QMD_FORCE_CPU CI=true /opt/homebrew/opt/node@24/bin/node ./node_modules/vitest/vitest.mjs run --testTimeout 60000 test/store.test.ts -t "generateEmbeddings"` → all pass, then the State 3 full-suite command → `EXIT=0` (RED: not yet run — add the reason assertion first and see it fail)

## State 5 — land the index allowlist (qmd#6)
Tier: T0 — one tracked config file, `.qmd/index.yml`, nothing executes it.
Deliverable: `chore/index-allowlist-handover` (3c4d725) pushed to origin and a PR opened against `rodaddy/v2.6.3-repo-local` with the qmd#6 receipt in the body; if it no longer applies cleanly, rebase it onto the current base first.
Scope: branch `chore/index-allowlist-handover`, the PR.
Must NOT: run `qmd update` or `aqmd up` inside qmd (rule 4), merge the PR, edit `.qmd/index.yml` by hand beyond the rebase.
Record: qmd#6
Done-check: `forgejo-api.sh GET 'repos/rodaddy/qmd/pulls?state=open' | jq -r '.[].head.ref'` lists `chore/index-allowlist-handover`

## State 6 — WAYFINDER QUOTA
Close: qmd#8 and qmd#7 on Forgejo when their done-checks pass, each closing comment carrying the command and result; qmd#6 closes when Rico merges its PR, so comment the PR link and leave it open.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Merge of PR rodaddy/qmd#9 into `rodaddy/v2.6.3-repo-local`: Rico's call; State 2 branches differently depending on it.
- llama-swap is no longer a pod in k3s namespace `ai`; the endpoint serves, but which workload backs it and whether rtech-infra#1213 (OOM loop) still applies is UNVERIFIED.
- `check-drained.sh` exits 1 on this fork's inherited remote branches (copilot/*, dependabot/*, REPL, lenient-docid, fix/*, feat/skills-layout-scaffold) and on `rodaddy/v2.6.3-repo-local` having no PR; standing fork state per rule 1, not a session's to delete.
- GitHub rodaddy/qmd PR #4 (feat/skills-layout-scaffold → main) still needs Rico's D1: base it on `rodaddy/v2.6.3-repo-local` or keep qmd `main` as the MCP revision.
- `~/.cache/qmd/models` (2.1 GB, three .gguf) is dead weight; removal is Rico's: `mv ~/.cache/qmd/models ~/.Trash/qmd-models-2026-08-27`.
- dev#354 (clause-6 fixture on `wip/2026-08-27`) and the tmp-path refusal in `_ob/bin/qmd` are Development lanes, not qmd.
- The `codex:codex-rescue` harness-gate refusal (rule 12) is a Development-side defect in the gate prose or the companion prompt; no issue filed there yet.
