/**
 * no-local-models.test.ts - the invariant that no model loads in this process.
 *
 * This fork serves embed, rerank and generate from a remote server. The
 * failure it exists to prevent is not "slow": it is a configuration that
 * SAYS remote and quietly computes locally, or hands a `https://` model field
 * to node-llama-cpp, which treats it as something to download (404, exit 1).
 * Both were live defects. These tests pin the three things that stop them
 * coming back:
 *   1. chunking tokenizes over the LLM interface, so a remote embed role
 *      tokenizes on the server instead of loading a gguf to count tokens;
 *   2. an hf: URI raises LocalModelsDisabledError rather than loading;
 *   3. createLLM is the only path to a backend -- nothing constructs one
 *      directly, which is how the local class got reached past the factory.
 */

import { describe, test, expect, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { AddressInfo } from "net";
import { RemoteLLM } from "../src/remote-llm";
import { LocalModelsDisabledError, createLLM, pullModels } from "../src/llm";

/**
 * A stand-in for llama-swap: records what it was asked and answers in
 * llama-server's own shape. Real HTTP rather than a stubbed fetch, so the URL
 * derivation -- the part most likely to be wrong -- is actually exercised
 * rather than asserted against a mock's expectations.
 */
function startFakeServer(): Promise<{
  server: Server;
  baseUrl: string;
  paths: string[];
  bodies: unknown[];
}> {
  const paths: string[] = [];
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      paths.push(req.url ?? "");
      const body = raw ? JSON.parse(raw) : {};
      bodies.push(body);
      res.setHeader("Content-Type", "application/json");
      // Only this one model is mounted, so a request for any other upstream
      // 404s exactly as llama-swap would. Matching on the path suffix alone
      // would answer for every model and hide a wrong URL derivation.
      const mounted = req.url?.startsWith("/upstream/embed-gemma/");
      if (mounted && req.url?.endsWith("/tokenize")) {
        // One token per word, ids offset so they are distinguishable from
        // lengths and indexes in an assertion failure.
        const words = String(body.content ?? "")
          .split(/\s+/)
          .filter(Boolean);
        res.end(JSON.stringify({ tokens: words.map((_w, i) => 1000 + i) }));
        return;
      }
      if (mounted && req.url?.endsWith("/detokenize")) {
        const tokens = (body.tokens ?? []) as number[];
        res.end(
          JSON.stringify({ content: tokens.map((t) => `w${t}`).join(" ") }),
        );
        return;
      }
      if (req.url === "/v1/embeddings") {
        const input = body.input as string[];
        res.end(
          JSON.stringify({
            data: input.map((_t, index) => ({ index, embedding: [0.1, 0.2] })),
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        paths,
        bodies,
      });
    });
  });
}

let running: Server | null = null;
afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running!.close(() => resolve()));
    running = null;
  }
});

describe("remote tokenizer round-trip", () => {
  test("tokenize and detokenize hit the model's own upstream endpoints", async () => {
    const fake = await startFakeServer();
    running = fake.server;

    const llm = new RemoteLLM({ embedModel: `${fake.baseUrl}#embed-gemma` });

    const tokens = await llm.tokenize("alpha beta gamma");
    expect(tokens).toEqual([1000, 1001, 1002]);

    const text = await llm.detokenize(tokens);
    expect(text).toBe("w1000 w1001 w1002");

    // The OpenAI surface has no tokenizer; llama-swap exposes each upstream
    // llama-server at /upstream/<model>/. Getting this wrong would 404 at
    // re-index time, a long way from the config field that caused it.
    expect(fake.paths).toEqual([
      "/upstream/embed-gemma/tokenize",
      "/upstream/embed-gemma/detokenize",
    ]);
    expect(fake.bodies[0]).toEqual({ content: "alpha beta gamma" });
    expect(fake.bodies[1]).toEqual({ tokens: [1000, 1001, 1002] });
  });

  test("detokenizing nothing makes no request", async () => {
    const fake = await startFakeServer();
    running = fake.server;
    const llm = new RemoteLLM({ embedModel: `${fake.baseUrl}#embed-gemma` });

    expect(await llm.detokenize([])).toBe("");
    expect(fake.paths).toEqual([]);
  });

  test("a server that is not llama-server is named, not silently accepted", async () => {
    const fake = await startFakeServer();
    running = fake.server;
    // #other routes to /upstream/other/..., which this server 404s.
    const llm = new RemoteLLM({ embedModel: `${fake.baseUrl}#other` });
    await expect(llm.tokenize("x")).rejects.toThrow();
  });
});

describe("remote request bodies are valid JSON for llama-server", () => {
  test("a lone surrogate is repaired before it reaches the wire", async () => {
    const fake = await startFakeServer();
    running = fake.server;
    const llm = new RemoteLLM({ embedModel: `${fake.baseUrl}#embed-gemma` });

    // A chunk cut through the middle of an astral character keeps only the
    // low half; llama-server 500s on the resulting "\\udf4c" escape.
    const lone = "kanban \udf4c board";
    const out = await llm.embedBatch([lone, "plain"]);

    expect(out.map((r) => (r ? r.embedding.length : null))).toEqual([2, 2]);
    const sent = fake.bodies.find((b) =>
      Array.isArray((b as { input?: unknown }).input),
    ) as { input: string[] };
    expect(sent.input[0]).toBe("kanban \ufffd board");
    expect(sent.input[0].isWellFormed()).toBe(true);
    expect(sent.input[1]).toBe("plain");
  });
});

describe("local models are refused", () => {
  test("an hf: embed URI raises LocalModelsDisabledError naming role and URI", async () => {
    const uri = "hf:ggml-org/embeddinggemma-300M-GGUF/model.gguf";
    const llm = createLLM({ embed: uri, generate: uri, rerank: uri });

    // The refusal lands when work is attempted, which is where the URI is
    // known and where a caller can act on it.
    const error = await llm.embed("hello").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalModelsDisabledError);
    const err = error as LocalModelsDisabledError;
    expect(err.message).toContain("embed");
    expect(err.message).toContain(uri);
    // Every instance of this is a config field needing an edit, so the fix
    // must be in the message rather than in documentation somewhere else.
    expect(err.message).toContain("https://host/v1#model-name");
  });

  test("pull refuses before touching the model cache", async () => {
    const error = await pullModels([
      "hf:ggml-org/embeddinggemma-300M-GGUF/model.gguf",
    ]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalModelsDisabledError);
  });

  test("the refusal carries its own exit code, distinct from a generic failure", () => {
    expect(LocalModelsDisabledError.EXIT_CODE).toBe(3);
    expect(LocalModelsDisabledError.EXIT_CODE).not.toBe(1);
  });
});

describe("createLLM is the only constructor path", () => {
  const srcFile = (...parts: string[]) =>
    readFileSync(join(process.cwd(), "src", ...parts), "utf-8");

  test("no module outside llm.ts constructs a backend directly", () => {
    // llm.ts owns the factory, so it is the one file allowed to name the
    // class. index.ts constructing its own is what made a store ignore a
    // configured remote server and hand the URL to node-llama-cpp.
    for (const file of [["index.ts"], ["store.ts"], ["cli", "qmd.ts"]]) {
      expect(srcFile(...file)).not.toContain("new LlamaCpp(");
    }
  });

  test("no module outside llm.ts reaches for the local backend", () => {
    for (const file of [["index.ts"], ["store.ts"], ["cli", "qmd.ts"]]) {
      expect(srcFile(...file)).not.toContain("getLocalLlamaCpp");
    }
  });

  test("the SDK store builds its backend through createLLM", () => {
    expect(srcFile("index.ts")).toContain("createLLM(");
  });
});
