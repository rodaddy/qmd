/**
 * llm.test.ts - Unit tests for the LLM abstraction layer.
 *
 * Every role is served by a remote llama-server, so the integration blocks
 * below exercise real HTTP against the configured server rather than loading
 * a model in-process. They are skipped under CI, which has no server to reach.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  createLLM,
  getDefaultLlamaCpp,
  disposeDefaultLlamaCpp,
  resolveEmbedModel,
  resolveGenerateModel,
  resolveRerankModel,
  resolveModels,
  withLLMSession,
  canUnloadLLM,
  SessionReleasedError,
  type RerankDocument,
  type ILLMSession,
  type EmbeddingResult,
} from "../src/llm.js";

describe("model name resolution", () => {
  function withModelEnv(
    env: Record<string, string | undefined>,
    fn: () => void,
  ): void {
    const previous = {
      QMD_EMBED_MODEL: process.env.QMD_EMBED_MODEL,
      QMD_GENERATE_MODEL: process.env.QMD_GENERATE_MODEL,
      QMD_RERANK_MODEL: process.env.QMD_RERANK_MODEL,
    };
    try {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("all model roles resolve config hints before env fallbacks", () => {
    withModelEnv(
      {
        QMD_EMBED_MODEL: "env-embed",
        QMD_GENERATE_MODEL: "env-generate",
        QMD_RERANK_MODEL: "env-rerank",
      },
      () => {
        const config = {
          embed: "config-embed",
          generate: "config-generate",
          rerank: "config-rerank",
        };
        expect(resolveEmbedModel(config)).toBe("config-embed");
        expect(resolveGenerateModel(config)).toBe("config-generate");
        expect(resolveRerankModel(config)).toBe("config-rerank");
        expect(resolveModels(config)).toEqual(config);
      },
    );
  });

  // The backend a config produces must report the same model fields the
  // standalone resolvers do, or a caller reading embedModelName off the
  // backend fingerprints its vectors against a different model than the one
  // that computed them.
  test("the built backend reports the same fields the resolvers do", () => {
    withModelEnv(
      {
        QMD_EMBED_MODEL: "env-embed",
        QMD_GENERATE_MODEL: "env-generate",
        QMD_RERANK_MODEL: "env-rerank",
      },
      () => {
        const config = {
          embed: "config-embed",
          generate: "config-generate",
          rerank: "config-rerank",
        };
        const llm = createLLM(config);
        expect(llm.embedModelName).toBe(resolveEmbedModel(config));
        expect(llm.generateModelName).toBe(resolveGenerateModel(config));
        expect(llm.rerankModelName).toBe(resolveRerankModel(config));
      },
    );
  });
});

// =============================================================================
// Singleton Tests (no model loading required)
// =============================================================================

describe("Default backend singleton", () => {
  // Test singleton behavior without resetting to avoid orphan instances
  test("getDefaultLlamaCpp returns same instance on subsequent calls", () => {
    const llm1 = getDefaultLlamaCpp();
    const llm2 = getDefaultLlamaCpp();
    expect(llm1).toBe(llm2);
  });

  // The defaults name the remote server, so the default backend is remote.
  // Asserted by the model field it reports rather than by class: there is no
  // local class left to be an instance of, and the field is what callers
  // actually read to fingerprint vectors and pick a prompt format.
  test("the default backend is remote, not a local model", () => {
    expect(getDefaultLlamaCpp().embedModelName).toMatch(/^https?:\/\//);
  });
});

// =============================================================================
// Model Existence Tests
// =============================================================================

describe("modelExists for local model fields", () => {
  // A build with no in-process runtime cannot serve any local model, so both
  // an hf: ref and a path answer the same way: absent. This is a probe rather
  // than a compute path, so it reports rather than throwing -- the throw is
  // pinned separately in no-local-models.test.ts.
  test("an hf: URI reports absent rather than resolving", async () => {
    const uri = "hf:org/repo/model.gguf";
    const llm = createLLM({ embed: uri, generate: uri, rerank: uri });
    const result = await llm.modelExists(uri);

    expect(result.exists).toBe(false);
  });

  test("a local path reports absent", async () => {
    const uri = "hf:org/repo/model.gguf";
    const llm = createLLM({ embed: uri, generate: uri, rerank: uri });
    const result = await llm.modelExists("/nonexistent/path/model.gguf");

    expect(result.exists).toBe(false);
  });
});

// =============================================================================
// Integration Tests (require a reachable remote llama-server)
// =============================================================================

describe.skipIf(!!process.env.CI)("Remote backend integration", () => {
  // The configured default backend, which serves every role over HTTP.
  const llm = getDefaultLlamaCpp();

  afterAll(async () => {
    await disposeDefaultLlamaCpp();
  });

  describe("embed", () => {
    test("returns embedding with correct dimensions", async () => {
      const result = await llm.embed("Hello world");

      expect(result).not.toBeNull();
      expect(result!.embedding).toBeInstanceOf(Array);
      expect(result!.embedding.length).toBeGreaterThan(0);
      // embeddinggemma outputs 768 dimensions
      expect(result!.embedding.length).toBe(768);
    });

    test("returns consistent embeddings for same input", async () => {
      const result1 = await llm.embed("test text");
      const result2 = await llm.embed("test text");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Embeddings should be identical for the same input
      for (let i = 0; i < result1!.embedding.length; i++) {
        expect(result1!.embedding[i]).toBeCloseTo(result2!.embedding[i]!, 5);
      }
    });

    test("returns different embeddings for different inputs", async () => {
      const result1 = await llm.embed("cats are great");
      const result2 = await llm.embed("database optimization");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Calculate cosine similarity - should be less than 1.0 (not identical)
      let dotProduct = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < result1!.embedding.length; i++) {
        const v1 = result1!.embedding[i]!;
        const v2 = result2!.embedding[i]!;
        dotProduct += v1 * v2;
        norm1 += v1 ** 2;
        norm2 += v2 ** 2;
      }
      const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

      expect(similarity).toBeLessThan(0.95); // Should be meaningfully different
    });
  });

  describe("embedBatch", () => {
    test("returns embeddings for multiple texts", async () => {
      const texts = ["Hello world", "Test text", "Another document"];
      const results = await llm.embedBatch(texts);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).not.toBeNull();
        expect(result!.embedding.length).toBe(768);
      }
    });

    test("returns same results as individual embed calls", async () => {
      const texts = ["cats are great", "dogs are awesome"];

      // Get batch embeddings
      const batchResults = await llm.embedBatch(texts);

      // Get individual embeddings
      const individualResults = await Promise.all(
        texts.map((t) => llm.embed(t)),
      );

      // Compare - should be identical
      for (let i = 0; i < texts.length; i++) {
        expect(batchResults[i]).not.toBeNull();
        expect(individualResults[i]).not.toBeNull();
        for (let j = 0; j < batchResults[i]!.embedding.length; j++) {
          expect(batchResults[i]!.embedding[j]).toBeCloseTo(
            individualResults[i]!.embedding[j]!,
            5,
          );
        }
      }
    });

    test("handles empty array", async () => {
      const results = await llm.embedBatch([]);
      expect(results).toHaveLength(0);
    });
  });

  describe("rerank", () => {
    test("scores capital of France question correctly", async () => {
      const query = "What is the capital of France?";
      const documents: RerankDocument[] = [
        {
          file: "butterflies.txt",
          text: "Butterflies indeed fly through the garden.",
        },
        { file: "france.txt", text: "The capital of France is Paris." },
        { file: "canada.txt", text: "The capital of Canada is Ottawa." },
      ];

      const result = await llm.rerank(query, documents);

      expect(result.results).toHaveLength(3);

      // The France document should score highest
      expect(result.results[0]!.file).toBe("france.txt");
      expect(result.results[0]!.score).toBeGreaterThan(0.7);

      // Canada should be somewhat relevant (also about capitals)
      expect(result.results[1]!.file).toBe("canada.txt");

      // Butterflies should score lowest
      expect(result.results[2]!.file).toBe("butterflies.txt");
      expect(result.results[2]!.score).toBeLessThan(0.6);
    });

    test("scores authentication query correctly", async () => {
      const query = "How do I configure authentication?";
      const documents: RerankDocument[] = [
        {
          file: "weather.md",
          text: "The weather today is sunny with mild temperatures.",
        },
        {
          file: "auth.md",
          text: "Authentication can be configured by setting the AUTH_SECRET environment variable.",
        },
        {
          file: "pizza.md",
          text: "Our restaurant serves the best pizza in town.",
        },
        {
          file: "jwt.md",
          text: "JWT authentication requires a secret key and expiration time.",
        },
      ];

      const result = await llm.rerank(query, documents);

      expect(result.results).toHaveLength(4);

      // Auth documents should score highest
      const topTwo = result.results.slice(0, 2).map((r) => r.file);
      expect(topTwo).toContain("auth.md");
      expect(topTwo).toContain("jwt.md");

      // Irrelevant documents should score lowest
      const bottomTwo = result.results.slice(2).map((r) => r.file);
      expect(bottomTwo).toContain("weather.md");
      expect(bottomTwo).toContain("pizza.md");
    });

    test("handles programming queries correctly", async () => {
      const query = "How do I handle errors in JavaScript?";
      const documents: RerankDocument[] = [
        {
          file: "cooking.md",
          text: "To make a good pasta, boil water and add salt.",
        },
        {
          file: "errors.md",
          text: "Use try-catch blocks to handle JavaScript errors gracefully.",
        },
        {
          file: "python.md",
          text: "Python uses try-except for exception handling.",
        },
      ];

      const result = await llm.rerank(query, documents);

      // JavaScript errors doc should score highest
      expect(result.results[0]!.file).toBe("errors.md");
      expect(result.results[0]!.score).toBeGreaterThan(0.7);

      // Python doc might be somewhat relevant (same concept, different language)
      // Cooking should be least relevant
      expect(result.results[2]!.file).toBe("cooking.md");
    });

    test("handles empty document list", async () => {
      const result = await llm.rerank("test query", []);
      expect(result.results).toHaveLength(0);
    });

    test("handles single document", async () => {
      const result = await llm.rerank("test", [
        { file: "doc.md", text: "content" },
      ]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.file).toBe("doc.md");
    });

    test("preserves original file paths", async () => {
      const documents: RerankDocument[] = [
        { file: "path/to/doc1.md", text: "content one" },
        { file: "another/path/doc2.md", text: "content two" },
      ];

      const result = await llm.rerank("query", documents);

      const files = result.results.map((r) => r.file).sort();
      expect(files).toEqual(["another/path/doc2.md", "path/to/doc1.md"]);
    });

    test("returns scores between 0 and 1", async () => {
      const documents: RerankDocument[] = [
        { file: "a.md", text: "The quick brown fox jumps over the lazy dog." },
        {
          file: "b.md",
          text: "Machine learning algorithms process data efficiently.",
        },
        {
          file: "c.md",
          text: "React components use JSX syntax for rendering.",
        },
      ];

      const result = await llm.rerank("Tell me about animals", documents);

      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
      }
    });

    test("batch reranks multiple documents efficiently", async () => {
      // Create 10 documents to verify batch processing works
      const documents: RerankDocument[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          file: `doc${i}.md`,
          text: `Document number ${i} with some content about topic ${i % 3}`,
        }));

      const start = Date.now();
      const result = await llm.rerank("topic 1", documents);
      const elapsed = Date.now() - start;

      expect(result.results).toHaveLength(10);

      // Verify all documents are returned with valid scores
      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
      }

      // Log timing for monitoring batch performance
      console.log(`Batch rerank of 10 docs took ${elapsed}ms`);
    });

    test("truncates and reranks document exceeding 2048 token context size", async () => {
      // The reranker context is created with contextSize=2048. Documents that
      // exceed the token budget (contextSize - template overhead - query tokens)
      // should be silently truncated rather than crashing.
      const paragraph =
        "The quick brown fox jumps over the lazy dog near the riverbank. " +
        "Authentication tokens must be validated on every request to ensure security. " +
        "Database queries should use prepared statements to prevent SQL injection attacks. " +
        "The deployment pipeline includes linting, testing, building, and publishing stages. ";
      // ~320 chars per paragraph, repeat 40 times = ~12800 chars ≈ 3200 tokens
      const longText = paragraph.repeat(40);

      const query = "How do I configure authentication?";
      const documents: RerankDocument[] = [
        {
          file: "short-relevant.md",
          text: "Authentication can be configured by setting AUTH_SECRET.",
        },
        { file: "long-doc.md", text: longText },
        { file: "short-irrelevant.md", text: "The weather is sunny today." },
      ];

      console.log(
        `Long doc length: ${longText.length} chars (~${Math.round(longText.length / 4)} tokens)`,
      );

      const result = await llm.rerank(query, documents);

      // Should return all 3 documents without crashing
      expect(result.results).toHaveLength(3);

      // All scores should be valid numbers in [0, 1]
      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
        expect(Number.isNaN(doc.score)).toBe(false);
      }

      // The short, directly relevant doc should still rank highest
      console.log("Rerank results for long doc test:");
      for (const doc of result.results) {
        console.log(`  ${doc.file}: ${doc.score.toFixed(4)}`);
      }
    }, 30000);
  });

  describe("expandQuery", () => {
    test("returns query expansions with correct types", async () => {
      const result = await llm.expandQuery("test query");

      // Result is Queryable[] containing lex, vec, and/or hyde entries
      expect(result.length).toBeGreaterThanOrEqual(1);

      // Each result should have a valid type
      for (const q of result) {
        expect(["lex", "vec", "hyde"]).toContain(q.type);
        expect(q.text.length).toBeGreaterThan(0);
      }
    }, 30000); // 30s timeout for model loading

    test("can exclude lexical queries", async () => {
      const result = await llm.expandQuery("authentication setup", {
        includeLexical: false,
      });

      // Should not contain any 'lex' type entries
      const lexEntries = result.filter((q) => q.type === "lex");
      expect(lexEntries).toHaveLength(0);
    });
  });
});

// =============================================================================
// Session Management Tests
// =============================================================================

describe.skipIf(!!process.env.CI)("LLM Session Management", () => {
  describe("withLLMSession", () => {
    test("session provides access to LLM operations", async () => {
      const result = await withLLMSession(async (session) => {
        expect(session.isValid).toBe(true);
        const embedding = await session.embed("test text");
        expect(embedding).not.toBeNull();
        expect(embedding!.embedding.length).toBe(768);
        return "success";
      });
      expect(result).toBe("success");
    });

    test("session is invalid after release", async () => {
      let capturedSession: ILLMSession | null = null;

      await withLLMSession(async (session) => {
        capturedSession = session;
        expect(session.isValid).toBe(true);
      });

      // Session should be invalid after withLLMSession returns
      expect(capturedSession).not.toBeNull();
      expect(capturedSession!.isValid).toBe(false);
    });

    test("session prevents idle unload during operations", async () => {
      await withLLMSession(async (session) => {
        // While inside a session, canUnloadLLM should return false
        expect(canUnloadLLM()).toBe(false);

        // Perform an operation
        await session.embed("test");

        // Still should not be able to unload
        expect(canUnloadLLM()).toBe(false);
      });

      // After session ends, should be able to unload
      expect(canUnloadLLM()).toBe(true);
    });

    test("nested sessions increment ref count", async () => {
      await withLLMSession(async (outerSession) => {
        expect(canUnloadLLM()).toBe(false);

        await withLLMSession(async (innerSession) => {
          expect(canUnloadLLM()).toBe(false);
          expect(innerSession.isValid).toBe(true);
          expect(outerSession.isValid).toBe(true);
        });

        // Inner session released, but outer still active
        expect(canUnloadLLM()).toBe(false);
        expect(outerSession.isValid).toBe(true);
      });

      // All sessions released
      expect(canUnloadLLM()).toBe(true);
    });

    test("session embedBatch works correctly", async () => {
      await withLLMSession(async (session) => {
        const texts = ["Hello world", "Test text", "Another document"];
        const results = await session.embedBatch(texts);

        expect(results).toHaveLength(3);
        for (const result of results) {
          expect(result).not.toBeNull();
          expect(result!.embedding.length).toBe(768);
        }
      });
    });

    test("session rerank works correctly", async () => {
      await withLLMSession(async (session) => {
        const documents: RerankDocument[] = [
          { file: "a.txt", text: "The capital of France is Paris." },
          { file: "b.txt", text: "Dogs are great pets." },
        ];

        const result = await session.rerank(
          "What is the capital of France?",
          documents,
        );

        expect(result.results).toHaveLength(2);
        expect(result.results[0]!.file).toBe("a.txt");
        expect(result.results[0]!.score).toBeGreaterThan(
          result.results[1]!.score,
        );
      });
    });

    test("max duration aborts session after timeout", async () => {
      let aborted = false;

      try {
        await withLLMSession(
          async (session) => {
            // Wait longer than max duration
            await new Promise((resolve) => setTimeout(resolve, 150));

            // This operation should throw because session was aborted
            await session.embed("test");
          },
          { maxDuration: 50 },
        ); // 50ms max
      } catch (err) {
        if (err instanceof SessionReleasedError) {
          aborted = true;
        } else {
          throw err;
        }
      }

      expect(aborted).toBe(true);
    }, 5000);

    test("external abort signal propagates to session", async () => {
      const abortController = new AbortController();
      let sessionAborted = false;

      const promise = withLLMSession(
        async (session) => {
          // Wait a bit then check if aborted
          await new Promise((resolve) => setTimeout(resolve, 100));

          if (!session.isValid) {
            sessionAborted = true;
            throw new SessionReleasedError("Session aborted");
          }

          return "should not reach";
        },
        { signal: abortController.signal },
      );

      // Abort after 20ms
      setTimeout(() => abortController.abort(), 20);

      try {
        await promise;
      } catch (err) {
        // Expected
      }

      expect(sessionAborted).toBe(true);
    }, 5000);

    test("session provides abort signal for monitoring", async () => {
      await withLLMSession(async (session) => {
        expect(session.signal).toBeInstanceOf(AbortSignal);
        expect(session.signal.aborted).toBe(false);
      });
    });

    test("returns value from callback", async () => {
      const result = await withLLMSession(async (session) => {
        await session.embed("test");
        return { status: "complete", count: 42 };
      });

      expect(result).toEqual({ status: "complete", count: 42 });
    });

    test("propagates errors from callback", async () => {
      const customError = new Error("Custom test error");

      await expect(
        withLLMSession(async () => {
          throw customError;
        }),
      ).rejects.toThrow("Custom test error");
    });
  });
});
