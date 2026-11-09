/**
 * search-collection-filter.test.ts — several collections filter in SQL, not after the limit.
 *
 * A named index with several collections (or several `-c`) used to search every
 * collection in the store, keep the top `limit`, and post-filter. Other indexes'
 * documents filled the page and the filter emptied it (qmd#41).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore,
  insertContent,
  insertDocument,
  hashContent,
  type Store,
} from "../src/store.js";
import type { CollectionConfig } from "../src/collections.js";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/_scratch/qmd-tests";

describe("searchFTS with several collections", () => {
  let testDir: string;
  let store: Store;
  let originalConfigDir: string | undefined;

  beforeAll(async () => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    testDir = await mkdtemp(join(SCRATCH_ROOT, "collection-filter-"));
    originalConfigDir = process.env.QMD_CONFIG_DIR;
    const configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    const emptyConfig: CollectionConfig = { collections: {} };
    await writeFile(join(configDir, "index.yml"), YAML.stringify(emptyConfig));
    process.env.QMD_CONFIG_DIR = configDir;
    store = createStore(join(testDir, "index.sqlite"));

    const now = new Date().toISOString();
    // The decoy collection outranks the wanted ones on every row.
    const docs: [collection: string, path: string, body: string][] = [
      ...Array.from({ length: 12 }, (_, i): [string, string, string] => [
        "other",
        `decoy-${i}.md`,
        "flaky test flaky test flaky test retry",
      ]),
      ["a", "one.md", "a flaky test"],
      ["b", "two.md", "another flaky test"],
    ];
    for (const [collection, path, body] of docs) {
      const hash = await hashContent(`${collection}/${body}/${path}`);
      insertContent(store.db, hash, body, now);
      insertDocument(store.db, collection, path, path, hash, now, now);
    }
  });

  afterAll(async () => {
    store.close();
    if (originalConfigDir === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = originalConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  test("the named collections fill the page even when another collection outranks them", () => {
    const rows = store.searchFTS("flaky test", 5, ["a", "b"]);
    expect(rows.map((r) => r.displayPath).sort()).toEqual([
      "a/one.md",
      "b/two.md",
    ]);
  });
});
