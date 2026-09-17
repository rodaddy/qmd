/**
 * store-list-files.test.ts - listCollectionFiles: the one walk behind
 * reindexCollection.
 *
 * An allowlist (array pattern) used to be handed to fast-glob whole, whose
 * cost grows superlinearly with the pattern count; the Development
 * allowlist (~4,100 patterns) blew past the librarian's 30-minute job
 * timeout. The walk now happens once and picomatch admits per file. These
 * tests pin the semantics that must not move while doing that:
 *
 * - an allowlisted directory contributes only its OWN files (no recursion)
 * - the hardcoded exclude dirs and hidden segments stay out, even when a
 *   pattern names them
 * - per-collection `ignore` still applies
 * - a string pattern behaves exactly as before
 *
 * Proven red 2026-09-16 by replacing the allowlist matcher with `() => true`:
 * all five allowlist tests failed, the string-pattern test stayed green.
 */

import { describe, test, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { listCollectionFiles } from "../src/store.js";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/_scratch/qmd-tests";

let root: string;

async function touch(relative: string): Promise<void> {
  const full = join(root, relative);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, `# ${relative}\n`);
}

beforeAll(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  root = await mkdtemp(join(SCRATCH_ROOT, "list-files-"));
  await Promise.all(
    [
      "top.md",
      "top.txt",
      "docs/a.md",
      "docs/a.ts",
      "docs/sub/b.md",
      "docs/sub/deep/c.md",
      "notes/n.md",
      "docs/node_modules/pkg/readme.md",
      "docs/.hidden/h.md",
      ".github/workflows/ci.md",
      "src/x.ts",
    ].map(touch),
  );
});

describe("listCollectionFiles with an allowlist", () => {
  test("a directory pattern admits only that directory's own files", async () => {
    const files = await listCollectionFiles(root, ["docs/*.md", "*.md"]);
    expect(files.sort()).toEqual(["docs/a.md", "top.md"]);
  });

  test("a glob that spans directories still recurses", async () => {
    const files = await listCollectionFiles(root, ["docs/**/*.md"]);
    expect(files.sort()).toEqual([
      "docs/a.md",
      "docs/sub/b.md",
      "docs/sub/deep/c.md",
    ]);
  });

  test("exclude dirs and hidden segments stay out even when named", async () => {
    const files = await listCollectionFiles(root, [
      "docs/node_modules/pkg/*.md",
      "docs/.hidden/*.md",
      ".github/workflows/*.md",
    ]);
    expect(files).toEqual([]);
  });

  test("per-collection ignore patterns still apply", async () => {
    const files = await listCollectionFiles(
      root,
      ["docs/*.md", "notes/*.md"],
      ["notes/**"],
    );
    expect(files).toEqual(["docs/a.md"]);
  });

  test("brace extension lists admit each extension", async () => {
    const files = await listCollectionFiles(root, ["docs/*.{md,ts}"]);
    expect(files.sort()).toEqual(["docs/a.md", "docs/a.ts"]);
  });
});

describe("listCollectionFiles with a string pattern", () => {
  test("recurses, skips exclude dirs and hidden paths, honors ignore", async () => {
    const files = await listCollectionFiles(root, "**/*.md", ["notes/**"]);
    expect(files.sort()).toEqual([
      "docs/a.md",
      "docs/sub/b.md",
      "docs/sub/deep/c.md",
      "top.md",
    ]);
  });
});
