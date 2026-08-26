# HANDOFF RULES — qmd (layer 0.1)

Repo-specific rules every handover in this repo needs. Overrides
HANDOFF-BASE.md; overridden by the handover document. Keep short; add a rule
only when a session actually needed it.

1. This is a FORK of `tobi/qmd`, not our code. The working branch is
   `rodaddy/v2.6.3-repo-local` and `main` tracks upstream. Local patches and
   known upstream defects are recorded in `FORK.md` — read it before
   concluding a behaviour is a bug in our work.

2. `qmd embed` and `qmd update` are GPU- and disk-bound and must never run
   automatically (`CLAUDE.md`). A full re-embed pins hardware for minutes.
   Time them deliberately; do not fire them to "check something."

3. The librarian daemon (port 7141) serializes every qmd write on this
   machine. Bypass it for benchmarks with `AQMD_VIA_LIBRARIAN=0` and
   `LIBRARIAN_CHILD=1`, or the measurement is of the queue, not of qmd.

4. Running qmd from two directories in one session overwrites the wrong
   index — `qmd` resolves `.qmd/` by walking UP from cwd. A benchmark run
   from inside `qmd/` clobbered Development's index on 2026-08-25. Name the
   directory each command runs in.

5. Config lives in `.qmd/index.yml` and IS tracked. `qmd update` rewrites its
   `pattern:` allowlist as a side effect, so a dirty `index.yml` after a run
   is usually machine-regenerated, not an edit — diff it before committing.

6. Postgres-backend runs take `QMD_BACKEND=postgres` and a `QMD_POSTGRES_URL`
   whose password lives ONLY in Vaultwarden ("PostgreSQL - general qmd",
   host 10.71.20.167:5432, db `qmd`). `scripts/bench-postgres.sh <dir> <label>`
   builds the URL at run time and bypasses the librarian; never write the URL
   to a file in the repo. Tables `chunks`, `docs`, `wtest` in that database are
   hand-loaded research data, not qmd's; qmd owns `documents`, `content`,
   `content_vectors`, `vectors`, `llm_cache`, `store_collections`,
   `store_config`.

7. The librarian daemon runs its own `embed:Development` against the live
   SQLite index on its own schedule (seen 2026-08-26 01:39). A changed
   `.qmd/index.sqlite` mtime is not evidence your run touched it; check
   `~/Library/Logs/exemplar-librarian.err.log` for that minute first.

8. A `codex:codex-rescue` Workflow node cannot run a shell outside the
   session's cwd; a lane whose files live in another directory sits for
   minutes doing nothing (2026-08-26). Route qmd lanes as native Opus 5 low
   in-harness workers with that reason stated.

9. `qmd` under `bin/qmd` prefers `bun src/cli/qmd.ts` when bun is present;
   `timeout` then kills only the launcher and the bun child survives, and a
   SIGTERM handler that cannot run while the main thread is blocked makes it
   immortal. For timed or diagnosed runs call
   `node dist/cli/qmd.js` directly after `npm run build`.

10. **Check `user` CPU against wall time before optimizing the Postgres
    write path.** run3 of the full embed was 190.66s wall with 15.94s user:
    the process was waiting on remote inference (~17ms/chunk, serial). The
    whole Postgres write path is under 3s (all 10,779 rows insert in
    42.8ms, full HNSW build 2.2s). A microbenchmark of 2,000 separate
    inserts (4.5s) was misread as index-maintenance cost and produced a
    bulk-mode lane that measured zero gain and was reverted (c9aa2f9). The
    lever for a full load is the embedding endpoint, not storage.
