/**
 * context-lookup-memo.test.ts — getContextForFile reads the collection table once
 * per burst, not once per row.
 *
 * Each call used to query store_collections, re-parse every collection's
 * patterns (4,208 for Development), query it again by name, and read the global
 * context. Profiled live 2026-09-29 (dev#565): 1.0 s of a 1.55 s `qmd search`.
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
  getContextForFile,
  syncConfigToDb,
  type Store,
} from "../src/store.js";
import type { CollectionConfig } from "../src/collections.js";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/_scratch/qmd-tests";

describe("getContextForFile collection lookups", () => {
  let testDir: string;
  let store: Store;
  let originalConfigDir: string | undefined;

  beforeAll(async () => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    testDir = await mkdtemp(join(SCRATCH_ROOT, "context-memo-"));
    originalConfigDir = process.env.QMD_CONFIG_DIR;
    const configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    const config: CollectionConfig = {
      collections: {
        Development: {
          path: join(testDir, "tree"),
          pattern: "**/*.md",
          context: { "/": "the fixture tree" },
        },
      },
    };
    await writeFile(join(configDir, "index.yml"), YAML.stringify(config));
    process.env.QMD_CONFIG_DIR = configDir;
    store = createStore(join(testDir, "index.sqlite"));
    syncConfigToDb(store.db, config);
    const now = new Date().toISOString();
    for (const path of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
      const hash = await hashContent(`body ${path}`);
      insertContent(store.db, hash, `body ${path}`, now);
      insertDocument(store.db, "Development", path, path, hash, now, now);
    }
  });

  afterAll(async () => {
    store.close();
    if (originalConfigDir === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = originalConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  test("five rows in one burst read store_collections once, with the same answers", () => {
    const files = ["a.md", "b.md", "c.md", "d.md", "e.md"].map(
      (p) => `qmd://Development/${p}`,
    );
    const db = store.db;
    const realPrepare = db.prepare.bind(db);
    let collectionReads = 0;
    db.prepare = ((sql: string) => {
      if (sql.includes("store_collections")) collectionReads++;
      return realPrepare(sql);
    }) as typeof db.prepare;
    try {
      const contexts = files.map((f) => getContextForFile(db, f));
      expect(new Set(contexts).size).toBe(1);
      expect(contexts[0]).toContain("the fixture tree");
      expect(collectionReads).toBeLessThanOrEqual(1);
    } finally {
      db.prepare = realPrepare;
    }
  });
});
