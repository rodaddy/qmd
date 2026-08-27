# Handover — qmd embed-abort exit and the flaky daemon-stop test (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read qmd/_DOCS/HANDOVER-RULES.md in full (72 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
Work happens in /Volumes/ThunderBolt/Development/qmd, never a clone. Run
`qmd`/`aqmd` from /Volumes/ThunderBolt/Development (rules 4 and 9, and the
Development router: root checkout only). Forge is Forgejo `rodaddy/qmd`
(origin). API helper (keychain credential):
`/Volumes/ThunderBolt/_tmp/development/_scratch/forgejo-api.sh <METHOD> <path> [json-file]`.
- PR rodaddy/qmd#3 open, feat/no-local-models (fff0d8d) → rodaddy/v2.6.3-repo-local; merge is Rico's — WRITTEN (`forgejo-api.sh GET repos/rodaddy/qmd/pulls/3 | jq .state` → open)
- Runtime is the node@24 keg; better-sqlite3 built for ABI 137; `_ob/bin/qmd` exports `QMD_NODE` to the keg before its ABI guard (Development `wip/2026-08-27` bdfc7af1) — RUNNING (`QMD_NODE=/opt/homebrew/opt/node@24/bin/node zsh _ob/bin/qmd-abi-guard check` → OK; `cd Development && qmd doctor` → `device mode: remote`)
- Suite under the keg at fff0d8d: 1 failed | 883 passed | 73 skipped; the one is qmd#4 — RUNNING (`env -u QMD_FORCE_CPU /opt/homebrew/opt/node@24/bin/node scripts/test-all.mjs`)
- qmd#1 (ABI) and qmd#2 (embed abort attribution) closed with receipts; qmd#4 (flaky stop test) and qmd#5 (abort exits 0) open — RUNNING (`forgejo-api.sh GET repos/rodaddy/qmd/issues?state=open | jq length` → 2)
- llama-swap serves from k3s `ai/llama-swap-6579bb95b5-8f9cf` on k3s-node-04 and is OOM-looping under embed load: rtech-infra#1213 — RUNNING (`KUBECONFIG=~/.kube/config-rtech-k3s kubectl -n ai get pod` → 9 restarts)
- dev#354 open: the clause-6 fixture fails on `wip/2026-08-27` now that 7130d53a is in `origin/main`; receipt commented, checker-side fix is Development work — RUNNING (`forgejo-api.sh GET repos/rodaddy/development/issues/354 | jq -r .state` → open)
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh | wc -l` → 5)
Re-probe before dispatching anything (live state beats this doc):
- `git status -sb && git log --oneline -1` → `feat/no-local-models` at fff0d8d or later, only `.qmd/index.yml` dirty
- `forgejo-api.sh GET repos/rodaddy/qmd/pulls/3 | jq .state` → open, else State 2 cuts the new branch
- `curl -s -o /dev/null -w '%{http_code}' https://llama-swap.rodaddy.live/v1/models` → 200, else no embed lanes at all

## State 2 — LAND THE PAPERWORK
Branch: `feat/no-local-models` from `origin/main` — cut it if absent; if the
checkout is `main` or PR #3 is merged, cut `fix/embed-abort-exit` from
`rodaddy/v2.6.3-repo-local` instead, never work on either.
Commit this handover: branch `feat/no-local-models`, path
`_DOCS/_handover/2026-08-27-embed-abort-and-flaky-stop.md`, explicit-path
staging, `git commit -F` message file.
Scribe: rodaddy/qmd PR #3 (Forgejo) — started: `forgejo-api.sh POST repos/rodaddy/qmd/issues/3/comments <json-file with {"body":"**agent:** ... handover landed at <sha>"}>`; lane receipts go to the issue each lane names.
Done-check: `git log -1 --stat`

## State 3 — deterministic daemon-stop test (qmd#4)
Tier: T0 — test-only change, one file, nothing reads it.
Deliverable: `test/cli.test.ts` "mcp http daemon > stop kills daemon and removes PID file" polls `process.kill(pid, 0)` up to 5s instead of one fixed `sleep(500)`; the assertion is unchanged.
Scope: test/cli.test.ts, that one test.
Must NOT: touch src/, change timeouts of other tests, skip or retry the test.
Record: qmd#4
Done-check: `env -u QMD_FORCE_CPU /opt/homebrew/opt/node@24/bin/node scripts/test-all.mjs` → 0 failed | 884 passed | 73 skipped (RED: fff0d8d, /Volumes/ThunderBolt/_tmp/qmd/_scratch/test-all-node24-rebuilt-2.log:970)

## State 4 — embed abort exits non-zero (qmd#5)
Tier: T1 — shared CLI behaviour; the librarian records every `qmd embed` exit code and would now see the abort.
Deliverable: when the error-rate abort at `src/store.ts:2657-2667` fires, `qmd embed` exits 1 after its summary, with the existing warn line kept; a test in test/ drives the abort with a stub embedder and asserts the exit code.
Scope: src/store.ts (abort branch return value), src/cli/qmd.ts (exit code on that result), one new or extended test file.
Must NOT: change the 80% threshold or `BATCH_SIZE`, run `qmd embed` against the live index, touch the librarian.
Record: qmd#5
Done-check: the new test passes and the suite is 0 failed under the keg; `FORK.md` gains one line naming the divergence from upstream (RED: not yet run)

## State 5 — WAYFINDER QUOTA
Close: qmd#4 and qmd#5 on Forgejo when their done-checks pass; each closing comment carries the done-check command and result.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Merge of PR rodaddy/qmd#3 into `rodaddy/v2.6.3-repo-local`: Rico's call.
- rtech-infra#1213 (llama-swap OOM loop, 11Gi limit) is infra work; until it moves, any embed lane can hit the qmd#2 pattern.
- dev#354: the fix on main reproduces the issue title; the clause needs an evidence source other than the host repo's diff. Development lane, not qmd.
- `~/.cache/qmd/models` (2.1 GB, three .gguf, no open handles) is dead weight; removal is Rico's: `mv ~/.cache/qmd/models ~/.Trash/qmd-models-2026-08-27`.
- Graph Mode v1.3-beta vendored into open-brain (`d1f9fcf0`, PR #892) and software-factory (`b00a9f0`, PR #428) against the ruling that beta lives only in Development docs; reverting waits on Rico's explicit "revert them".
- GitHub rodaddy/qmd PR #4 (feat/skills-layout-scaffold → main) still needs Rico's D1: base it on `rodaddy/v2.6.3-repo-local` or keep qmd `main` as the MCP revision.
- `check-drained.sh` exits 1 on this fork's inherited remote branches (copilot/*, dependabot/*, lenient-docid, fix/*, feat/skills-layout-scaffold) and on `rodaddy/v2.6.3-repo-local` having no PR; standing fork state per rule 1, not this session's to delete.
- `.qmd/index.yml` in qmd and in the Development root is machine-regenerated (rule 5), and Development `.claude/commands/get-on-track.md` is untracked; all reported, none committed by this session.
- The Development-side tmp-path refusal in `_ob/bin/qmd` (Rico, 2026-08-27) is a Development agent's lane; it edits the same wrapper file as bdfc7af1.
