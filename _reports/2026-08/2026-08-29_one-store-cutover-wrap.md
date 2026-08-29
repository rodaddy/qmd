# Session wrap — one store on Postgres, librarian faults (2026-08-28/29)

Session 05c29c5a. Head: claude-fable-5. Verify against live state before
trusting any line below.

## State at wrap (RUNNING unless noted)

- One qmd store on Postgres (10.71.20.167, db `qmd`): 54 collections, one
  per Development folder, 17,043 files, 81,052 vectors, 0 pending.
  Catalogue `Development/.qmd/index.yml`; wrapper `_ob/bin/qmd` defaults
  `QMD_BACKEND=postgres`, credential from the login keychain only.
- Per-repo `.qmd/` dirs and every `index.sqlite` moved to
  `~/.Trash/qmd-per-repo-2026-08-28/` (58 items plus 4 recreated strays).
  55 repos still show ` D .qmd/index.yml` uncommitted; this repo commits
  its own deletion in this wrap.
- `aqmd` scopes from the catalogue before the walk-up; `qmd init` under a
  catalogued folder is refused (dev#358, dev#359).
- Librarian: last jobs `done exit 0`; menubar overrun budget floors at
  300s (7bd64fb0 on Development `wip/2026-08-29`).
- rerank-qwen3 on ai-01: `-c 4096 -b 4096 -ub 4096` (rtech-infra#1277),
  client budget 3072.
- qmd fork: rodaddy/qmd#10 merged (lone-surrogate repair in
  `RemoteLLM.post`), suite EXIT=0 at e69f58e.

## What was done

1. Parallel embed: 4 workers, one `-c` per process (the flag takes one
   collection, last wins), concurrency 8, all 4 server slots busy.
2. rodaddy/qmd#10: `toWellFormed()` replacer on request bodies; one
   half-emoji chunk had been failing whole batches.
3. Development #357 (one-store config + wrapper), #358 (aqmd scoping),
   #359 (init refusal, rerank budget); rtech-infra #1266, #1276 (merge
   commit landed the base tree, re-landed as #1277).
4. Menubar floor plus two tests (17 passed).
5. Proofs: cross-repo and scoped recall, removal (`1 new` then
   `1 removed`), `qmd init` refusal, stray per-repo file ignored.

## Traps

- Forgejo `Do: merge` on #1276 produced a merge commit with the base tree
  and reported merged=true. Read the file back from `main` after a merge.
- The librarian's failed-job stderr is base64 in `/status`; decode it
  every time. Three faults in one evening were three different limits.
- zsh does not word-split an unquoted `$var` in `set -- $var`.
- `git checkout --` is hook-blocked; `git show HEAD:path > path` restores
  an agent-owned file.

## Left open

- Commit the `.qmd/index.yml` deletion in the other 54 repos (one PR each).
- `qmd context` is empty: 54 one-line collection descriptions.
- Fold `~/.config/qmd/ref-*.yml` research collections into the catalogue
  with `collection exclude` as the evict lever.
- k3s hosting of librarian+qmd: spec written, parked by Rico (2026-08-29).
