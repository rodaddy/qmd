/**
 * update-paths.test.ts - targeted single-file re-indexing (`qmd update <path>`)
 *
 * Covers reindexPaths: add, update, remove, hash-skip, and the embedding
 * staleness that `qmd embed` keys off. The outside-collection error is owned by
 * the CLI resolver and is asserted through the built CLI in cli-update-paths.
 *
 * Fixtures live under the repo temp workspace, never /tmp.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtemp, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore,
  reindexCollection,
  reindexPaths,
  getHashesNeedingEmbedding,
  getEmbeddingFingerprint,
  type Store,
  type ReindexTarget,
} from "../src/store.js";
import type { CollectionConfig } from "../src/collections.js";

const MODEL = "test-embed-model";
const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/qmd/_scratch";

let testDir: string;
let store: Store;
let collectionDir: string;
const COLLECTION = "fixture";

/** Every fixture file goes through the real collection walk first. */
async function seedCollection(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(collectionDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  await reindexCollection(store, collectionDir, "**/*.md", COLLECTION);
}

function target(relativePath: string): ReindexTarget {
  return {
    collectionName: COLLECTION,
    collectionPath: collectionDir,
    relativePath,
  };
}

function activeDocs(): { path: string; hash: string; modified_at: string }[] {
  return store.db
    .prepare(
      `SELECT path, hash, modified_at FROM documents
       WHERE collection = ? AND active = 1 ORDER BY path`,
    )
    .all(COLLECTION) as { path: string; hash: string; modified_at: string }[];
}

beforeAll(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  testDir = await mkdtemp(join(SCRATCH_ROOT, "update-paths-"));
  process.env.QMD_CONFIG_DIR = testDir;
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(join(testDir, "index.yml"), YAML.stringify(emptyConfig));
});

afterAll(async () => {
  store?.close();
  delete process.env.QMD_CONFIG_DIR;
});

beforeEach(async () => {
  store?.close();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store = createStore(join(testDir, `db-${stamp}.sqlite`));
  collectionDir = await mkdtemp(join(testDir, "collection-"));
});

describe("reindexPaths", () => {
  test("adds a file the index has never seen", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha" });
    await writeFile(join(collectionDir, "b.md"), "# B\n\nbravo");

    const result = await reindexPaths(store, [target("b.md")]);

    expect(result.indexed).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.outcomes).toEqual([
      { collectionName: COLLECTION, relativePath: "b.md", action: "indexed" },
    ]);
    expect(activeDocs().map((d) => d.path)).toEqual(["a.md", "b.md"]);
  });

  test("updates a changed file and leaves every other doc untouched", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
    const before = activeDocs();

    await writeFile(join(collectionDir, "a.md"), "# A\n\nalpha rewritten");
    const result = await reindexPaths(store, [target("a.md")]);

    expect(result.updated).toBe(1);
    expect(result.indexed).toBe(0);

    const after = activeDocs();
    expect(after).toHaveLength(before.length);
    // Only a.md's hash moved.
    expect(after[0]!.hash).not.toBe(before[0]!.hash);
    expect(after[1]!.hash).toBe(before[1]!.hash);
  });

  test("removes a doc whose file is gone, without a collection walk", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
    await unlink(join(collectionDir, "a.md"));

    const result = await reindexPaths(store, [target("a.md")]);

    expect(result.removed).toBe(1);
    expect(result.outcomes[0]!.action).toBe("removed");
    expect(activeDocs().map((d) => d.path)).toEqual(["b.md"]);
  });

  test("skips an unchanged file on content-hash match", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha" });
    const before = activeDocs()[0]!;

    const result = await reindexPaths(store, [target("a.md")]);

    expect(result.unchanged).toBe(1);
    expect(result.indexed).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.outcomes[0]!.action).toBe("unchanged");
    // Untouched: same hash AND same modified_at row.
    expect(activeDocs()[0]).toEqual(before);
  });

  test("a path neither disk nor index knows is skipped, not an error", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha" });

    const result = await reindexPaths(store, [target("ghost.md")]);

    expect(result.skipped).toBe(1);
    expect(result.removed).toBe(0);
    expect(activeDocs().map((d) => d.path)).toEqual(["a.md"]);
  });

  test("handles several paths, each with its own outcome, in one call", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
    await writeFile(join(collectionDir, "a.md"), "# A\n\nalpha rewritten");
    await writeFile(join(collectionDir, "c.md"), "# C\n\ncharlie");

    const result = await reindexPaths(store, [
      target("a.md"),
      target("b.md"),
      target("c.md"),
    ]);

    expect(result).toMatchObject({
      indexed: 1,
      updated: 1,
      unchanged: 1,
      removed: 0,
    });
    expect(result.outcomes.map((o) => o.action)).toEqual([
      "updated",
      "unchanged",
      "indexed",
    ]);
  });
});

describe("reindexPaths embedding staleness", () => {
  /**
   * Staleness is not a flag: a doc is pending when its content hash has no rows
   * in content_vectors. These assert that representation directly rather than a
   * derived counter, so a parallel flag could not pass them by accident.
   */
  function vectorRowsFor(hash: string): number {
    return (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM content_vectors WHERE hash = ?`)
        .get(hash) as { n: number }
    ).n;
  }

  /**
   * Fake an embed pass for every active doc so the index starts fully fresh.
   * The fingerprint is derived from the model name, so it must be the real one
   * or getHashesNeedingEmbedding would never match these rows.
   */
  function markAllEmbedded(): void {
    const now = new Date().toISOString();
    const fingerprint = getEmbeddingFingerprint(MODEL);
    for (const doc of activeDocs()) {
      store.db
        .prepare(
          `INSERT INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
           VALUES (?, 0, 0, ?, ?, 1, ?)`,
        )
        .run(doc.hash, MODEL, fingerprint, now);
    }
  }

  test("a changed doc becomes pending; its unchanged neighbour does not", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha", "b.md": "# B\n\nbravo" });
    markAllEmbedded();

    const before = activeDocs();
    const staleHash = before[0]!.hash;
    const untouchedHash = before[1]!.hash;
    expect(vectorRowsFor(staleHash)).toBe(1);

    await writeFile(join(collectionDir, "a.md"), "# A\n\nalpha rewritten");
    await reindexPaths(store, [target("a.md")]);

    const after = activeDocs();
    const newHash = after[0]!.hash;
    expect(newHash).not.toBe(staleHash);

    // The new hash has no vectors -> pending. That IS the stale mark.
    expect(vectorRowsFor(newHash)).toBe(0);
    // The neighbour still has its vectors -> embed will not redo it.
    expect(vectorRowsFor(untouchedHash)).toBe(1);

    // And the count qmd embed keys off sees exactly one doc.
    expect(getHashesNeedingEmbedding(store.db, COLLECTION, MODEL)).toBe(1);
  });

  test("an unchanged doc is left embedded — nothing becomes pending", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha" });
    markAllEmbedded();
    expect(getHashesNeedingEmbedding(store.db, COLLECTION, MODEL)).toBe(0);

    const result = await reindexPaths(store, [target("a.md")]);

    expect(result.unchanged).toBe(1);
    expect(getHashesNeedingEmbedding(store.db, COLLECTION, MODEL)).toBe(0);
  });

  test("a newly added doc is pending immediately", async () => {
    await seedCollection({ "a.md": "# A\n\nalpha" });
    markAllEmbedded();

    await writeFile(join(collectionDir, "b.md"), "# B\n\nbravo");
    await reindexPaths(store, [target("b.md")]);

    expect(getHashesNeedingEmbedding(store.db, COLLECTION, MODEL)).toBe(1);
    const added = activeDocs().find((d) => d.path === "b.md")!;
    expect(vectorRowsFor(added.hash)).toBe(0);
  });
});
