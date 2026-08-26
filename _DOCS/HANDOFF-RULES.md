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
