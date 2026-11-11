/**
 * scoped-update-embed.test.ts - `qmd update|embed -c <name> --path <prefix>`
 *
 * A prefix scopes the collection walk (index + deactivate) and the pending
 * embed set to documents under it; no prefix keeps the whole collection.
 *
 * Fixtures live under the repo temp workspace, never /tmp.
 */

import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore,
  reindexCollection,
  getHashesNeedingEmbedding,
} from "../src/store.js";
import type { CollectionConfig } from "../src/collections.js";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/qmd/_scratch";
const COLLECTION = "fixture";
let testDir: string;

beforeAll(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  testDir = await mkdtemp(join(SCRATCH_ROOT, "scoped-update-embed-"));
  process.env.QMD_CONFIG_DIR = testDir;
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(join(testDir, "index.yml"), YAML.stringify(emptyConfig));
});

afterAll(() => {
  delete process.env.QMD_CONFIG_DIR;
});

async function put(dir: string, rel: string, body: string): Promise<void> {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), body);
}

// Seed: in/a.md and out/b.md indexed. Then add in/new.md and out/new.md and
// delete out/b.md, and run one scoped (or unscoped) update.
// One table-driven test (the repo's test budget only goes down).
const ROWS: {
  prefixes: string[] | undefined;
  active: string[];
  pending: number;
}[] = [
  // prefix: new file under it indexed, outside new file un-indexed, outside deletion stays active
  {
    prefixes: ["in/"],
    active: ["in/a.md", "in/new.md", "out/b.md"],
    pending: 2,
  },
  // no prefix: the whole collection is indexed and deactivated
  {
    prefixes: undefined,
    active: ["in/a.md", "in/new.md", "out/new.md"],
    pending: 3,
  },
];

test("update and embed --path scope the collection to the prefix", async () => {
  for (const { prefixes, active, pending } of ROWS)
    await scopedRun(prefixes, active, pending);
});

async function scopedRun(
  prefixes: string[] | undefined,
  active: string[],
  pending: number,
): Promise<void> {
  const store = createStore(join(testDir, `db-${Math.random()}.sqlite`));
  const dir = await mkdtemp(join(testDir, "collection-"));
  try {
    await put(dir, "in/a.md", "# A\n\nalpha");
    await put(dir, "out/b.md", "# B\n\nbravo");
    await reindexCollection(store, dir, "**/*.md", COLLECTION);
    await put(dir, "in/new.md", "# In\n\nnew inside");
    await put(dir, "out/new.md", "# Out\n\nnew outside");
    await unlink(join(dir, "out/b.md"));

    await reindexCollection(store, dir, "**/*.md", COLLECTION, {
      pathPrefixes: prefixes,
    });

    const rows = store.db
      .prepare(
        `SELECT path FROM documents WHERE collection = ? AND active = 1 ORDER BY path`,
      )
      .all(COLLECTION) as { path: string }[];
    expect(rows.map((r) => r.path)).toEqual(active);
    // Nothing is embedded, so pending under the prefix = active docs under it.
    expect(
      getHashesNeedingEmbedding(store.db, COLLECTION, undefined, prefixes),
    ).toBe(pending);
  } finally {
    store.close();
  }
}
