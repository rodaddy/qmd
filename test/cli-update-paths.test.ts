/**
 * cli-update-paths.test.ts - `qmd update <path>...` end to end
 *
 * Spawns the real CLI so path resolution, the outside-collection error, exit
 * codes, and the no-positional fallback are exercised as a user hits them.
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
import { mkdtemp, writeFile, mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import YAML from "yaml";
import { openDatabase } from "../src/db.ts";
import type { CollectionConfig } from "../src/collections.ts";

const SCRATCH_ROOT = "/Volumes/ThunderBolt/_tmp/qmd/_scratch";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const runnerArgs = isBunRuntime ? [qmdScript] : [tsxCli, qmdScript];

let testDir: string;
let configDir: string;
let dbPath: string;
let collectionDir: string;
const COLLECTION = "fixture";

async function runQmd(
  args: string[],
  cwd: string = collectionDir,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(process.execPath, [...runnerArgs, ...args], {
    cwd,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      QMD_CONFIG_DIR: configDir,
      PWD: cwd, // getPwd() reads PWD, so it must be set explicitly.
      QMD_DOCTOR_DEVICE_PROBE: "0",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

function activeDocs(): { path: string; hash: string; modified_at: string }[] {
  const db = openDatabase(dbPath);
  try {
    return db
      .prepare(
        `SELECT path, hash, modified_at FROM documents
         WHERE collection = ? AND active = 1 ORDER BY path`,
      )
      .all(COLLECTION) as { path: string; hash: string; modified_at: string }[];
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  testDir = await mkdtemp(join(SCRATCH_ROOT, "cli-update-paths-"));
});

afterAll(() => {
  // Fixtures are left in the temp workspace for inspection; nothing is deleted.
});

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  configDir = await mkdtemp(join(testDir, `config-${stamp}-`));
  dbPath = join(testDir, `db-${stamp}.sqlite`);
  collectionDir = await mkdtemp(join(testDir, `collection-${stamp}-`));

  await writeFile(join(collectionDir, "a.md"), "# A\n\nalpha");
  await writeFile(join(collectionDir, "b.md"), "# B\n\nbravo");

  const config: CollectionConfig = {
    collections: { [COLLECTION]: { path: collectionDir, pattern: "**/*.md" } },
  };
  await writeFile(join(configDir, "index.yml"), YAML.stringify(config));

  const seeded = await runQmd(["update"]);
  expect(seeded.exitCode).toBe(0);
});

describe("qmd update <path>", () => {
  test("re-indexes only the named file", async () => {
    const before = activeDocs();
    await writeFile(join(collectionDir, "a.md"), "# A\n\nalpha rewritten");

    const result = await runQmd(["update", "a.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("updated");
    expect(result.stdout).toContain("a.md");
    expect(result.stdout).toContain("1 updated");

    const after = activeDocs();
    expect(after).toHaveLength(before.length);
    expect(after[0]!.hash).not.toBe(before[0]!.hash);
    // The file that was not named is byte-for-byte the same index row.
    expect(after[1]).toEqual(before[1]);
  });

  test("accepts an absolute path", async () => {
    await writeFile(join(collectionDir, "a.md"), "# A\n\nabsolute rewrite");

    const result = await runQmd(["update", join(collectionDir, "a.md")]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 updated");
  });

  test("reports an unchanged file instead of silently doing nothing", async () => {
    const result = await runQmd(["update", "a.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unchanged");
    expect(result.stdout).toContain("1 unchanged");
  });

  test("adds a brand-new file", async () => {
    await writeFile(join(collectionDir, "c.md"), "# C\n\ncharlie");

    const result = await runQmd(["update", "c.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 new");
    expect(activeDocs().map((d) => d.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("removes a file that is gone from disk", async () => {
    await unlink(join(collectionDir, "a.md"));

    const result = await runQmd(["update", "a.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 removed");
    expect(activeDocs().map((d) => d.path)).toEqual(["b.md"]);
  });

  test("takes several paths in one invocation", async () => {
    await writeFile(join(collectionDir, "a.md"), "# A\n\nalpha rewritten");
    await writeFile(join(collectionDir, "c.md"), "# C\n\ncharlie");

    const result = await runQmd(["update", "a.md", "b.md", "c.md"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 new, 1 updated, 1 unchanged");
  });

  test("errors and touches nothing when a path is under no collection", async () => {
    const outside = await mkdtemp(join(testDir, "outside-"));
    await writeFile(join(outside, "stray.md"), "# Stray\n\nnot ours");
    const before = activeDocs();

    const result = await runQmd(["update", join(outside, "stray.md")]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Not inside any collection");
    expect(result.stderr).toContain("stray.md");
    // The error names the roots it consulted, so the fix is obvious.
    expect(result.stderr).toContain("Collection roots checked");
    expect(result.stderr).toContain(COLLECTION);
    expect(result.stderr).toContain(collectionDir);
    expect(activeDocs()).toEqual(before);
  });

  test("rejects the whole invocation if any path is outside, before writing", async () => {
    const outside = await mkdtemp(join(testDir, "outside-multi-"));
    await writeFile(join(outside, "stray.md"), "# Stray\n\nnot ours");
    await writeFile(join(collectionDir, "a.md"), "# A\n\nwould-be rewrite");
    const before = activeDocs();

    const result = await runQmd(["update", "a.md", join(outside, "stray.md")]);

    expect(result.exitCode).not.toBe(0);
    // a.md was valid and listed first, but nothing was applied.
    expect(activeDocs()).toEqual(before);
  });

  test("with no positional paths still walks whole collections", async () => {
    await writeFile(join(collectionDir, "c.md"), "# C\n\ncharlie");

    const result = await runQmd(["update"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All collections updated");
    expect(activeDocs().map((d) => d.path)).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("qmd help", () => {
  test("documents the positional-path form of update", async () => {
    const result = await runQmd(["--help"]);
    expect(result.stdout).toContain("qmd update <path>...");
  });
});
