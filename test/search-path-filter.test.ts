/**
 * search-path-filter.test.ts — the `--path <prefix>` filter.
 *
 * The filter exists so a caller wanting the best N hits inside ONE repository
 * can ask for them, instead of widening the search to everything
 * (`vsearch --all --min-score 0.2`, ~46s against the Development index) and
 * discarding the rest in code.
 *
 * Two layers are pinned here:
 *
 *  - `buildPathFilterClause` / `escapeLikePattern` — the SQL both backends
 *    share, including the wildcard escaping that keeps a literal `%` or `_`
 *    in a prefix literal.
 *  - `searchFTS` against a real SQLite store — that the clause actually
 *    restricts rows, that several prefixes OR, and that the no-filter path is
 *    byte-identical to what it was before the flag existed.
 *
 * `normalizePathPrefixes` (the CLI's `--path` → prefixes step) is covered too:
 * stored paths are collection-relative, so `/open-seo/` and `./open-seo/` must
 * reach the same rows as `open-seo/`.
 *
 * The vector arm is not exercised here: it needs an embedding backend. Its
 * SQL is the same `buildPathFilterClause` output, and the live timing proof
 * in the PR notes covers it end to end.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import {
  buildPathFilterClause,
  escapeLikePattern,
  createStore,
  insertContent,
  insertDocument,
  hashContent,
  type Store,
} from "../src/store.js";
import { normalizePathPrefixes } from "../src/cli/qmd.js";
import type { CollectionConfig } from "../src/collections.js";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/_scratch/qmd-tests";

// =============================================================================
// The shared SQL fragment
// =============================================================================

describe("escapeLikePattern", () => {
  test("leaves an ordinary path untouched", () => {
    expect(escapeLikePattern("open-seo/docs/")).toBe("open-seo/docs/");
  });

  test("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLikePattern("docs/100%_done/")).toBe("docs/100\\%\\_done/");
  });

  test("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });
});

describe("buildPathFilterClause", () => {
  test("returns null when there is nothing to filter", () => {
    expect(buildPathFilterClause("d.path", undefined)).toBeNull();
    expect(buildPathFilterClause("d.path", [])).toBeNull();
    expect(buildPathFilterClause("d.path", [""])).toBeNull();
  });

  test("one prefix becomes one escaped LIKE", () => {
    const clause = buildPathFilterClause("d.path", ["open-seo/"]);
    expect(clause).toEqual({
      sql: "(d.path LIKE ? ESCAPE '\\')",
      params: ["open-seo/%"],
    });
  });

  test("several prefixes are OR-ed", () => {
    const clause = buildPathFilterClause("d.path", [
      "open-seo/",
      "rtech-infra/",
    ]);
    expect(clause?.sql).toBe(
      "(d.path LIKE ? ESCAPE '\\' OR d.path LIKE ? ESCAPE '\\')",
    );
    expect(clause?.params).toEqual(["open-seo/%", "rtech-infra/%"]);
  });

  test("wildcards inside a prefix are escaped, not passed through", () => {
    const clause = buildPathFilterClause("d.path", ["docs/50%_off/"]);
    expect(clause?.params).toEqual(["docs/50\\%\\_off/%"]);
  });

  test("blank prefixes are dropped rather than matching everything", () => {
    const clause = buildPathFilterClause("d.path", ["", "notes/"]);
    expect(clause?.params).toEqual(["notes/%"]);
  });
});

// =============================================================================
// The CLI's --path normalisation
// =============================================================================

describe("normalizePathPrefixes", () => {
  test("undefined stays undefined (no filter)", () => {
    expect(normalizePathPrefixes(undefined)).toBeUndefined();
  });

  test("a leading slash or ./ is stripped — stored paths are relative", () => {
    expect(normalizePathPrefixes(["/open-seo/"])).toEqual(["open-seo/"]);
    expect(normalizePathPrefixes(["./open-seo/"])).toEqual(["open-seo/"]);
  });

  test("the trailing slash is preserved — it is part of the request", () => {
    expect(normalizePathPrefixes(["docs"])).toEqual(["docs"]);
    expect(normalizePathPrefixes(["docs/"])).toEqual(["docs/"]);
  });

  test("blank values drop out, and all-blank means no filter", () => {
    expect(normalizePathPrefixes(["", "  ", "a/"])).toEqual(["a/"]);
    expect(normalizePathPrefixes(["", "  "])).toBeUndefined();
  });

  test("several values survive as several prefixes", () => {
    expect(normalizePathPrefixes(["a/", "/b/"])).toEqual(["a/", "b/"]);
  });
});

// =============================================================================
// searchFTS against a real SQLite store
// =============================================================================

describe("searchFTS with a path filter", () => {
  let testDir: string;
  let store: Store;
  let originalConfigDir: string | undefined;

  /** Every document shares the search term so ranking cannot mask filtering. */
  const DOCS: [path: string, body: string][] = [
    ["open-seo/docs/keys.md", "The provider key lives in the environment"],
    ["open-seo/src/config.ts", "provider key loaded from the environment"],
    ["rtech-infra/docs/keys.md", "provider key stored in the environment"],
    ["fleet-bus/README.md", "provider key for the environment"],
    // Literal LIKE wildcards in the path: `%` and `_` must not act as wildcards.
    ["odd/100%_done/notes.md", "provider key in the environment"],
    ["odd/100Xydone/notes.md", "provider key in the environment"],
  ];

  beforeAll(async () => {
    await mkdir(SCRATCH_ROOT, { recursive: true });
    testDir = await mkdtemp(join(SCRATCH_ROOT, "path-filter-"));

    originalConfigDir = process.env.QMD_CONFIG_DIR;
    const configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    const emptyConfig: CollectionConfig = { collections: {} };
    await writeFile(join(configDir, "index.yml"), YAML.stringify(emptyConfig));
    process.env.QMD_CONFIG_DIR = configDir;

    store = createStore(join(testDir, "index.sqlite"));

    const now = new Date().toISOString();
    for (const [path, body] of DOCS) {
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

  const paths = (rows: { displayPath: string }[]): string[] =>
    rows.map((r) => r.displayPath.replace(/^Development\//, "")).sort();

  test("no filter returns every match (unchanged behaviour)", () => {
    const rows = store.searchFTS("provider key environment", 20);
    expect(paths(rows)).toEqual(DOCS.map(([p]) => p).sort());
  });

  test("an undefined or empty prefix list is the same as no filter", () => {
    const none = paths(store.searchFTS("provider key environment", 20));
    expect(
      paths(store.searchFTS("provider key environment", 20, undefined, [])),
    ).toEqual(none);
    expect(
      paths(
        store.searchFTS("provider key environment", 20, undefined, undefined),
      ),
    ).toEqual(none);
  });

  test("a prefix restricts results to that folder", () => {
    const rows = store.searchFTS("provider key environment", 20, undefined, [
      "open-seo/",
    ]);
    expect(paths(rows)).toEqual([
      "open-seo/docs/keys.md",
      "open-seo/src/config.ts",
    ]);
  });

  test("several prefixes are OR-ed together", () => {
    const rows = store.searchFTS("provider key environment", 20, undefined, [
      "rtech-infra/",
      "fleet-bus/",
    ]);
    expect(paths(rows)).toEqual([
      "fleet-bus/README.md",
      "rtech-infra/docs/keys.md",
    ]);
  });

  test("a deeper prefix narrows further", () => {
    const rows = store.searchFTS("provider key environment", 20, undefined, [
      "open-seo/src/",
    ]);
    expect(paths(rows)).toEqual(["open-seo/src/config.ts"]);
  });

  test("a full file path selects that one file", () => {
    const rows = store.searchFTS("provider key environment", 20, undefined, [
      "rtech-infra/docs/keys.md",
    ]);
    expect(paths(rows)).toEqual(["rtech-infra/docs/keys.md"]);
  });

  test("LIKE wildcards in a prefix are literal, not wildcards", () => {
    // Unescaped, `100%_done/` would also admit `100Xydone/`.
    const rows = store.searchFTS("provider key environment", 20, undefined, [
      "odd/100%_done/",
    ]);
    expect(paths(rows)).toEqual(["odd/100%_done/notes.md"]);
  });

  test("a prefix matching nothing returns nothing, not everything", () => {
    const rows = store.searchFTS("provider key environment", 20, undefined, [
      "no-such-repo/",
    ]);
    expect(rows).toEqual([]);
  });

  test("the filter composes with a collection filter", () => {
    expect(
      paths(
        store.searchFTS("provider key environment", 20, "Development", [
          "fleet-bus/",
        ]),
      ),
    ).toEqual(["fleet-bus/README.md"]);
    // A collection that holds none of these documents wins the AND.
    expect(
      store.searchFTS("provider key environment", 20, "Other", ["fleet-bus/"]),
    ).toEqual([]);
  });
});
