import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("LLM module loading", () => {
  // The original invariant was "node-llama-cpp is imported dynamically, not
  // statically", which kept a lightweight `qmd ls` from paying for the native
  // binding. This fork holds the stronger one: the runtime is never imported
  // at all, so no gguf can be loaded however the caller got there. Asserting
  // the absence of the dynamic import is what makes reintroducing a local
  // load a test failure rather than a silent regression.
  test("node-llama-cpp is never imported at runtime", () => {
    const source = readFileSync(join(process.cwd(), "src", "llm.ts"), "utf-8");

    expect(source).not.toMatch(
      /import\s+(?!type\b)[\s\S]*?from\s+["']node-llama-cpp["']/,
    );
    expect(source).not.toContain('import("node-llama-cpp")');
  });

  test("importing the CLI for lightweight commands succeeds", async () => {
    const mod = await import("../src/cli/qmd.ts");
    expect(mod).toMatchObject({
      buildEditorUri: expect.any(Function),
      termLink: expect.any(Function),
    });
  });
});
