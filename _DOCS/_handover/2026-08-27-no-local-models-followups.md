# Handover — qmd no-local-models follow-ups (2026-08-27)

## State 0 — BASE
Read /Volumes/ThunderBolt/Development/_DOCS/HANDOVER-BASE.md in full
(183 lines). It is the standing contract for this session.
- Any question this document does not directly override → the rules layers
  answer it, nearest layer first.
- Anything needed that neither the base nor this document covers → ask Rico
  before acting.
- Output discipline: minimum verbosity, only the context needed, output
  tokens low. If Rico wants more, he will ask.
- Layer 0.1: read qmd/_DOCS/HANDOVER-RULES.md in full (61 lines). It
  overrides the base; this document overrides it.

## State 1 — ORIENT
Work happens in /Volumes/ThunderBolt/Development/qmd, never a clone. Run
`qmd` commands from /Volumes/ThunderBolt/Development (rules 4 and 9).
Forge for this fork is Forgejo `rodaddy/qmd` (origin); GitHub `rodaddy/qmd`
has issues disabled and only old PRs. API helper (keychain credential):
`/Volumes/ThunderBolt/_tmp/development/_scratch/forgejo-api.sh <METHOD> <path> [json]`.
- PR rodaddy/qmd#3 open, feat/no-local-models (7f011de) → rodaddy/v2.6.3-repo-local; merge is Rico's — WRITTEN (`forgejo-api.sh GET repos/rodaddy/qmd/pulls/3` → open)
- No local model path remains: no node-llama-cpp import, class, or dependency; hf:/bare pins throw LocalModelsDisabledError exit 3 — RUNNING (`rg -n "node-llama-cpp" src/ package.json` → nothing; `npm run test:types` → 0)
- Suite at 7f011de: 9 failed | 875 passed | 73 skipped, the 9 are DEP0205 `expect(stderr).toBe("")` cases in test/cli.test.ts — RUNNING (`env -u QMD_FORCE_CPU node scripts/test-all.mjs`, PATH node v26.6.0)
- Same suite under the node@24 keg: 259 failed, one cause, better-sqlite3 built for ABI 147 — RUNNING (qmd#1, /Volumes/ThunderBolt/_tmp/qmd/_scratch/test-all-L5.log first run)
- Live wrapper `_ob/bin/qmd` runs dist/ from this branch via `/opt/homebrew/bin/node` — RUNNING (`cd /Volumes/ThunderBolt/Development && qmd doctor` → `device mode: remote`, `model cache: not applicable`)
- Development index healthy: 11101 vectors, fingerprint b423c5 — RUNNING (`qmd doctor` from Development)
- One embed pass aborted `Error rate too high (414/32)` at 12:38 after a successful 9660-chunk pass; cause unknown — UNVERIFIED (qmd#2)
- dev#354 (Forgejo rodaddy/development) still open; `7130d53a fix(graph-mode): the clause-6 passing fixture only passed in its own repo` is on Development `wip/2026-08-27` — MERGED, issue not closed (`git -C /Volumes/ThunderBolt/Development log --oneline -1 7130d53a`)
- Graph mode: converted — RUNNING (`ls scripts/done-means/*.sh | wc -l` → 5)
Re-probe before dispatching anything (live state beats this doc):
- `git status -sb && git log --oneline -1` → clean on `feat/no-local-models` at 7f011de or later
- `forgejo-api.sh GET repos/rodaddy/qmd/pulls/3 | jq .state` → open, else State 2 cuts the new branch
- `node -v; /opt/homebrew/opt/node@24/bin/node -v` → v26.6.0 and v24.19.0

## State 2 — LAND THE PAPERWORK
Branch: `feat/no-local-models` from `origin/main` — cut it if absent; if the
checkout is `main` or PR #3 is merged, cut `fix/node-abi-runtime` from
`rodaddy/v2.6.3-repo-local` instead, never work on either.
Commit this handover: branch `feat/no-local-models`, path
`_DOCS/_handover/2026-08-27-no-local-models-followups.md`, explicit-path
staging, `git commit -F` message file.
Scribe: rodaddy/qmd PR #3 (Forgejo) — started: `forgejo-api.sh POST repos/rodaddy/qmd/issues/3/comments <json with {"body":"**agent:** ... handover landed at <sha>"}>`; lane receipts go to the issue each lane names.
Done-check: `git log -1 --stat`

## State 3 — better-sqlite3 built for the pinned runtime (qmd#1)
Tier: T1 — `_ob/bin/qmd` is shared by every aqmd caller on this Mac; a wrong node breaks every write command.
Deliverable: node_modules/better-sqlite3 rebuilt under `/opt/homebrew/opt/node@24/bin/node` (`npm rebuild better-sqlite3` with that node first on PATH); `_ob/bin/qmd` line 405 `NODE_BIN=/opt/homebrew/bin/node` becomes the node@24 keg path; `scripts/test-all.mjs` documented to run under the keg in qmd/_DOCS/HANDOVER-RULES.md as rule 11.
Scope: qmd/node_modules/better-sqlite3, /Volumes/ThunderBolt/Development/_ob/bin/qmd (one line), qmd/_DOCS/HANDOVER-RULES.md.
Must NOT: change package.json engines, touch `_ob/bin/qmd-abi-guard`, rebuild any other native module, run `qmd embed`.
Record: qmd#1
Done-check: `env -u QMD_FORCE_CPU /opt/homebrew/opt/node@24/bin/node scripts/test-all.mjs` → 9 failed | 875 passed; `cd /Volumes/ThunderBolt/Development && qmd doctor` → exit 0 with `device mode: remote` (RED: 7f011de, 259 failed under the keg)

## State 4 — attribute the aborted embed pass (qmd#2)
Tier: T0 — read-only log correlation, nothing changes.
Deliverable: a comment on qmd#2 naming the cause of `Error rate too high (414/32)` with three receipts: the librarian err.log minute (`~/Library/Logs/exemplar-librarian.err.log` around 2026-08-27 12:34-12:38), the llama-swap log on the GPU box for the same minute (host per `/Volumes/collab/hostmap.json`), and the error counter site in src (`rg -n "Error rate too high" src/`). If the cause cannot be named, the comment says which of the three sources was silent.
Scope: read logs; write only the issue comment.
Must NOT: run `qmd embed` or `qmd update` to reproduce; restart the librarian; edit src.
Record: qmd#2
Done-check: `forgejo-api.sh GET repos/rodaddy/qmd/issues/2/comments | jq length` → 1 or more

## State 5 — close dev#354 with its receipt
Tier: T0 — the fix is already on `wip/2026-08-27`; this proves and records it.
Deliverable: from /Volumes/ThunderBolt/Development on `wip/2026-08-27`, run the decisions checker against `_ob/skills/graph-mode/beta/decisions/fixtures/pass-clause6-retire.md` (runner: `_ob/skills/graph-mode/beta/decisions/README.md` or the checker's own usage line) → exit 0; comment the command and exit code on dev#354 with the agent signature line, then close it.
Scope: Development read-only plus the issue.
Must NOT: edit fixtures or checkers; touch open-brain or software-factory.
Record: dev#354 (Forgejo rodaddy/development)
Done-check: `forgejo-api.sh GET repos/rodaddy/development/issues/354 | jq -r .state` → closed

## State 6 — WAYFINDER QUOTA
Close: qmd#1 and qmd#2 on Forgejo when their lanes' done-checks pass; each closing comment carries the done-check command and result.

## State FINAL — WRAP
Invoke the handover-author skill; next handover passes the validator; `aqmd up`.

## HANDED-OVER UNKNOWNS
- Merge of PR rodaddy/qmd#3 into `rodaddy/v2.6.3-repo-local`: Rico's call.
- `~/.cache/qmd/models` (2.1 GB, three .gguf, no open handles) is dead weight; removal is Rico's: `mv ~/.cache/qmd/models ~/.Trash/qmd-models-2026-08-27`.
- Graph Mode v1.3-beta was vendored into open-brain (`d1f9fcf0`, PR #892, on main) and software-factory (`b00a9f0`, PR #428, on main) against the ruling that beta lives only in Development docs; reverting waits on Rico's explicit "revert them".
- GitHub rodaddy/qmd PR #4 (feat/skills-layout-scaffold → main) still needs Rico's D1: base it on the working line `rodaddy/v2.6.3-repo-local` or keep qmd `main` as the MCP revision.
- `check-drained.sh` exits 1 on this fork's inherited remote branches (REPL, copilot/*, dependabot/*, lenient-docid, fix/*, feat/skills-layout-scaffold) and on `rodaddy/v2.6.3-repo-local` having no PR; standing fork state per rule 1, not this session's to delete.
- Development root: `.qmd/index.yml` is machine-regenerated (rule 5) and `.claude/commands/get-on-track.md` is untracked; both reported, neither committed by this session.
- `/Volumes/ThunderBolt/_tmp/software-factory/rw-boot-*` and `reconcile-agent-*` directories are runner workspaces of unknown ownership; not archived.
