/**
 * search-context.test.ts — the search pipelines do not pay for per-row context.
 *
 * getContextForFile costs several round trips per row on Postgres. searchFTS and
 * searchVec computed it for every candidate, and hybridQuery, vectorSearchQuery
 * and structuredSearch then dropped it and recomputed context for the rows they
 * return. Profiled live 2026-09-29 (dev#565): 1.5 s of a 3.5 s query. The
 * pipelines now pass withContext=false; a direct search keeps context by default.
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
  searchFTS,
  getContextLookupCount,
  type Store,
} from "../src/store.js";
import type { CollectionConfig } from "../src/collections.js";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/_scratch/qmd-tests";

describe("searchFTS row context", () => {
  let testDir: string;
  let store: Store;
  let originalConfigDir: string | undefined;

  beforeAll(async () => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    testDir = await mkdtemp(join(SCRATCH_ROOT, "search-context-"));
    originalConfigDir = process.env.QMD_CONFIG_DIR;
    const configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    const emptyConfig: CollectionConfig = { collections: {} };
    await writeFile(join(configDir, "index.yml"), YAML.stringify(emptyConfig));
    process.env.QMD_CONFIG_DIR = configDir;
    store = createStore(join(testDir, "index.sqlite"));
    const now = new Date().toISOString();
    for (const path of ["a.md", "b.md", "c.md"]) {
      const body = `provider key notes for ${path}`;
      const hash = await hashContent(body);
      insertContent(store.db, hash, body, now);
      insertDocument(store.db, "Development", path, path, hash, now, now);
    }
  });

  afterAll(async () => {
    store.close();
    if (originalConfigDir === undefined) delete process.env.QMD_CONFIG_DIR;
    else process.env.QMD_CONFIG_DIR = originalConfigDir;
    await rm(testDir, { recursive: true, force: true });
  });

  test("a direct search still attaches context to every row", () => {
    const before = getContextLookupCount();
    const rows = searchFTS(store.db, "provider", 20);
    expect(rows.length).toBe(3);
    expect(getContextLookupCount() - before).toBe(3);
  });

  test("withContext=false looks up no context at all", () => {
    const before = getContextLookupCount();
    const rows = searchFTS(
      store.db,
      "provider",
      20,
      undefined,
      undefined,
      false,
    );
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.context === null)).toBe(true);
    expect(getContextLookupCount() - before).toBe(0);
  });
});
