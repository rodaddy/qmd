# HANDOVER RULES — qmd (layer 0.1)

Repo-specific rules every handover in this repo needs. Overrides
HANDOVER-BASE.md; overridden by the handover document. Keep short; add a rule
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

11. The runtime is the node@24 keg, `/opt/homebrew/opt/node@24/bin/node`,
    never PATH `node` (v26 on this Mac). `better-sqlite3` is built for the
    keg (ABI 137); run the suite as
    `env -u QMD_FORCE_CPU /opt/homebrew/opt/node@24/bin/node scripts/test-all.mjs`
    and `npm rebuild better-sqlite3` only with the keg first on PATH and
    from this directory (from anywhere else `npm rebuild` reports success and
    touches nothing). `_ob/bin/qmd` exports `QMD_NODE` to the keg before its
    ABI guard runs; a wrapper or guard pointed at PATH node rebuilds the
    binary for v26 on the next `embed`/`update` and every keg caller breaks
    (2026-08-27 14:03, qmd#1).

12. A Luna `codex:codex-rescue` lane refuses a brief that touches more than
    one file: it reads the Development AGENTS.md harness gate as "multi-file
    work needs explicit approval" and stops, even when the brief grants
    single-agent approval up front (twice on 2026-08-27, jobs
    task-mtce2qrv-35kuba and task-mtce6lrh-l28uwj). Cut codex-rescue lanes
    to one file, or route a multi-file lane to native Opus 5 low with that
    reason (rule 8). Exit-code lanes prove the code with a subprocess run of
    the CLI, not a unit assertion on the returned object:
    `finishSuccessfulCliCommand` sat between the two and reset it (561abaa).

13. ONE STORE since 2026-08-28 (Rico ruling). Every folder under Development
    is a collection in `Development/.qmd/index.yml` on the Postgres backend;
    the per-repo `.qmd/` directories and every `index.sqlite` are retired and
    `_ob/bin/qmd` refuses `qmd init` under a catalogued folder (exit 4). Run
    `qmd`/`aqmd` from `/Volumes/ThunderBolt/Development` and scope with
    `-c qmd`; from inside this repo `aqmd` resolves the same scope from the
    catalogue. Rules 4, 5 and 7 describe the retired per-repo layout and are
    kept as history. The rerank server on ai-01 runs ubatch 4096 and the
    wrapper pins `QMD_REMOTE_RERANK_BATCH_TOKENS=3072`; change the two
    together (rtech-infra#1277, dev#359).
