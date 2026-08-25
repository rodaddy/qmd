/**
 * Remote OpenAI-compatible LLM backend.
 *
 * qmd 2.6.3 embeds in-process via node-llama-cpp. That pins the work to the
 * machine running qmd -- on a laptop a full re-index is minutes of 100% CPU
 * and multiple GB of RSS. This backend moves embed/rerank/generate onto any
 * server speaking the OpenAI shape (llama-swap, llama-server, vLLM, LM Studio,
 * an MLX server) while leaving every caller above ILLMSession untouched.
 *
 * Selected by URL: a model field spelled `http://host:8080/v1#model-name`
 * routes here, `hf:...` stays local. See parseRemoteModelUri.
 *
 * Behavioural parity with LlamaCpp is deliberate and load-bearing -- the two
 * are interchangeable behind the LLM interface, so:
 *   - embedBatch preserves input order and returns null per failed item
 *     rather than throwing (LlamaCpp: llm.ts embedBatch)
 *   - expandQuery falls back to the plain query rather than propagating
 *   - rerank returns results sorted by descending score
 * Prefix formatting (`task: search result | query: ...`) is NOT done here:
 * store.ts applies it before calling embed(), so both backends receive
 * byte-identical input.
 */

import { errorFields, logger } from "./logging.js";
import { HttpStatusError, TransportError, withRetry } from "./retry.js";
import type {
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  LLM,
  ModelInfo,
  Queryable,
  QueryType,
  RerankDocument,
  RerankOptions,
  RerankResult,
} from "./llm.js";

/** A model field that names a remote server: base URL plus model name. */
export type RemoteModelUri = {
  /** Base URL with no trailing slash, e.g. http://10.71.1.11:8080/v1 */
  baseUrl: string;
  /** Model name the server knows, from the URI fragment. */
  model: string;
};

/**
 * True when a model field names a remote server rather than a local file.
 * Deliberately narrow: only http(s). Anything else is not ours to claim.
 */
export function isRemoteModelUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/**
 * Split `http://host:8080/v1#model-name` into base URL and model name.
 *
 * The model name is REQUIRED. A server hosting several models cannot guess
 * which one is meant, and silently picking one is the failure class this
 * whole backend exists to remove -- a config that looks configured, works,
 * and is doing something other than what it says.
 */
export function parseRemoteModelUri(uri: string): RemoteModelUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(
      `Invalid remote model URL: ${JSON.stringify(uri)}. ` +
        `Expected http://host:port/v1#model-name`,
    );
  }

  const model = decodeURIComponent(parsed.hash.replace(/^#/, "")).trim();
  if (!model) {
    throw new Error(
      `Remote model URL is missing its model name: ${JSON.stringify(uri)}. ` +
        `Append the model as a URL fragment, e.g. ` +
        `${parsed.origin}${parsed.pathname}#embed-gemma`,
    );
  }

  parsed.hash = "";
  const baseUrl = parsed.toString().replace(/\/+$/, "");
  return { baseUrl, model };
}

/**
 * The model NAME from a model field, whatever its transport.
 *
 * Callers that branch on which model is active (isQwen3EmbeddingModel picking
 * a prompt format, for one) must not see the transport. A URL pointing at a
 * qwen embedder has "qwen" nowhere in its host, so matching against the raw
 * field silently selects the wrong prompt format and quietly degrades recall.
 */
export function modelIdentity(uri: string): string {
  if (!isRemoteModelUri(uri)) return uri;
  try {
    return parseRemoteModelUri(uri).model;
  } catch {
    return uri;
  }
}

/** Wire shape of an OpenAI /v1/embeddings response. */
type EmbeddingsResponse = {
  data?: { embedding?: number[]; index?: number }[];
  error?: unknown;
};

/** Wire shape of a /v1/rerank response (llama-server, Jina, Cohere-alike). */
type RerankResponse = {
  results?: { index?: number; relevance_score?: number; score?: number }[];
  error?: unknown;
};

/** Wire shape of an OpenAI /v1/chat/completions response. */
type ChatResponse = {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: unknown;
};

export type RemoteLLMConfig = {
  embedModel?: string;
  generateModel?: string;
  rerankModel?: string;
  /** Per-request timeout in ms. A cold model load on the server is slow. */
  requestTimeoutMs?: number;
  /**
   * Texts per embeddings request. The server batches natively; this only
   * bounds POST body size so one oversized call cannot stall a whole index.
   */
  embedBatchSize?: number;
  /**
   * Embedding requests in flight at once. The work is I/O-bound, so this is
   * about keeping the server busy, not about local CPU. Past what the server
   * can serve concurrently the extra requests just queue on its side.
   */
  concurrency?: number;
  /** Attempts per request, including the first. */
  attempts?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_EMBED_BATCH_SIZE = 32;
// Measured against llama-swap on an RTX 5060 Ti, 512 texts in 32-text batches:
// concurrency 1 = 525 texts/s, 2 = 890, 4 = 881, 8 = 853, 16 = 843. One
// in-flight request leaves the GPU idle between batches; past two the requests
// queue server-side and add latency without throughput. Raise only with a
// measurement from the server actually in use.
const DEFAULT_CONCURRENCY = 2;

/**
 * Read a positive-integer tuning knob from the environment.
 *
 * Throws on a malformed value rather than falling back to the default: a
 * sweep that silently ignores its own setting reports the default's numbers
 * under the override's name, which is worse than no knob at all.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * Token budget for one rerank request, matching a llama-server physical batch.
 *
 * llama.cpp scores a rerank pair in a single ubatch, so a pair exceeding the
 * server's `--ubatch-size` fails with "input (N tokens) is too large to
 * process" -- a 500 that no retry can fix. The local path budgets against its
 * own 4096-token context (llm.ts RERANK_CONTEXT_SIZE) using a real tokenizer;
 * a remote client has no tokenizer, so it budgets conservatively by character
 * count at qmd's own ~4 chars/token ratio (store.ts CHUNK_SIZE_CHARS).
 *
 * Defaults to 4096, matching both qmd's own RERANK_CONTEXT_SIZE and the
 * `-b 4096 -ub 4096` the rerank-qwen3 service runs with (k3s-deploy #140).
 * At parity the truncation below never fires and the reranker judges whole
 * chunks. Lower it with QMD_REMOTE_RERANK_BATCH_TOKENS for a server built with
 * a smaller ubatch: documents are then truncated to fit rather than rejected,
 * since a truncated score beats no score.
 */
const REMOTE_RERANK_BATCH_TOKENS: number = (() => {
  const v = parseInt(process.env.QMD_REMOTE_RERANK_BATCH_TOKENS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 4096;
})();

/** Qwen3 reranker chat template overhead, per llm.ts RERANK_TEMPLATE_OVERHEAD. */
const REMOTE_RERANK_TEMPLATE_OVERHEAD = 128;

/**
 * Characters per token, for budgeting without a tokenizer.
 *
 * store.ts uses 4 for CHUNK_SIZE_CHARS, which is right for prose. Source code,
 * markdown and CJK tokenize denser: measured against this server, a document
 * budgeted at 4 chars/token arrived as 570 tokens against a 384-token budget.
 * Budget at 2.5 so the estimate errs toward a request the server accepts --
 * a slightly short document still ranks, an oversized one 500s and scores
 * nothing.
 */
const CHARS_PER_TOKEN = 2.5;

/**
 * An OpenAI-compatible server reached over HTTP.
 *
 * One instance may serve all three roles or only some: each of embed,
 * generate and rerank is configured independently, so embeddings can run on a
 * GPU box while query expansion stays local. A role whose model field is not
 * a URL is not served here and throws if called.
 */
export class RemoteLLM implements LLM {
  private readonly embedUri?: RemoteModelUri;
  private readonly generateUri?: RemoteModelUri;
  private readonly rerankUri?: RemoteModelUri;
  private readonly embedModelField?: string;
  private readonly requestTimeoutMs: number;
  private readonly embedBatchSize: number;
  private readonly concurrency: number;
  /**
   * Vector width observed from the first successful embedding, used to reject
   * any later vector of a different width. Learned rather than configured:
   * the server owns the model, so it owns the dimension.
   */
  private expectedDimensions: number | undefined;

  constructor(config: RemoteLLMConfig = {}) {
    this.embedModelField = config.embedModel;
    this.embedUri =
      config.embedModel && isRemoteModelUri(config.embedModel)
        ? parseRemoteModelUri(config.embedModel)
        : undefined;
    this.generateUri =
      config.generateModel && isRemoteModelUri(config.generateModel)
        ? parseRemoteModelUri(config.generateModel)
        : undefined;
    this.rerankUri =
      config.rerankModel && isRemoteModelUri(config.rerankModel)
        ? parseRemoteModelUri(config.rerankModel)
        : undefined;
    this.requestTimeoutMs =
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // Env overrides so these can be swept against a live server without a
    // rebuild. Both defaults were measured against one specific GPU and server
    // config; the right value moves when either changes.
    this.embedBatchSize =
      config.embedBatchSize ??
      positiveIntFromEnv("QMD_REMOTE_EMBED_BATCH", DEFAULT_EMBED_BATCH_SIZE);
    this.concurrency = Math.max(
      1,
      config.concurrency ??
        positiveIntFromEnv("QMD_REMOTE_CONCURRENCY", DEFAULT_CONCURRENCY),
    );
  }

  /** The embed model field as configured, for fingerprinting and logging. */
  get embedModelName(): string {
    return this.embedModelField ?? "";
  }

  /**
   * The model NAME to send for a request.
   *
   * Callers pass whatever their configuration held, which for a remote backend
   * is the whole `http://host/v1#name` string. The server knows only `name`,
   * and answers a full URL with "no router for requested model" -- so resolve
   * every incoming override to its identity rather than forwarding it.
   */
  private wireModel(
    override: string | undefined,
    fallback: RemoteModelUri,
  ): string {
    if (!override) return fallback.model;
    // A local model reference is not a name this server knows. Callers default
    // their model parameter to qmd's built-in hf: constants (store.ts rerank()
    // is one), so an override arrives on every call whether or not the caller
    // meant to choose a model -- forwarding it asks llama-swap to route
    // "hf:ggml-org/..." and gets "no router for requested model".
    if (override.startsWith("hf:") || override.startsWith("/")) {
      return fallback.model;
    }
    const identity = modelIdentity(override);
    return identity === override && isRemoteModelUri(override)
      ? fallback.model
      : identity;
  }

  private require(role: "embed" | "generate" | "rerank"): RemoteModelUri {
    const uri =
      role === "embed"
        ? this.embedUri
        : role === "generate"
          ? this.generateUri
          : this.rerankUri;
    if (!uri) {
      throw new Error(
        `RemoteLLM has no ${role} model configured. Set models.${role} to a ` +
          `URL of the form http://host:port/v1#model-name`,
      );
    }
    return uri;
  }

  /**
   * POST JSON and parse the reply.
   *
   * Errors name the endpoint and carry the server's own body, because the
   * common failures here (wrong model name, model not loaded, endpoint absent)
   * are all distinguishable from the response and indistinguishable from
   * "something went wrong".
   */
  private async post<T>(
    baseUrl: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new TransportError(
        timedOut
          ? `timed out after ${this.requestTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
        url,
        timedOut,
      );
    } finally {
      // Always clear the timer: leaving it armed keeps the event loop alive
      // and, in a CLI that waits for the loop to drain, hangs the process.
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new HttpStatusError(
        `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
        response.status,
        url,
      );
    }

    const parsed = (await response.json()) as T & { error?: unknown };
    if (parsed && typeof parsed === "object" && parsed.error) {
      throw new Error(
        `Remote LLM request to ${url} returned an error: ` +
          `${JSON.stringify(parsed.error).slice(0, 500)}`,
      );
    }
    return parsed;
  }

  /**
   * Embed one text. Delegates to embedBatch so both paths agree by
   * construction rather than by two implementations staying in sync.
   */
  async embed(
    text: string,
    options: EmbedOptions = {},
  ): Promise<EmbeddingResult | null> {
    const [result] = await this.embedBatch([text], options);
    return result ?? null;
  }

  /**
   * Embed many texts in as few requests as the batch size allows.
   *
   * The whole reason this backend exists: an OpenAI-compatible server accepts
   * an array input and returns one vector per element, so a re-index costs one
   * request per batch instead of one per document.
   *
   * Parity with LlamaCpp.embedBatch: input order preserved, a failed batch
   * yields null for its own items only, an empty input yields [].
   */
  async embedBatch(
    texts: string[],
    options: EmbedOptions = {},
  ): Promise<(EmbeddingResult | null)[]> {
    if (texts.length === 0) return [];
    const uri = this.require("embed");
    const model = this.wireModel(options.model, uri);

    // Split into batches first, then run several concurrently. The work is
    // I/O-bound -- the GPU is on the other end of the socket and this process
    // is idle while a request is in flight -- so concurrency here is about not
    // leaving the server idle between batches, not about local CPU.
    const batches: { at: number; texts: string[] }[] = [];
    for (let at = 0; at < texts.length; at += this.embedBatchSize) {
      batches.push({ at, texts: texts.slice(at, at + this.embedBatchSize) });
    }

    const out: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);
    let failedBatches = 0;
    const startedAt = Date.now();

    const runBatch = async (batch: {
      at: number;
      texts: string[];
    }): Promise<void> => {
      try {
        const rows = await withRetry(
          async () => {
            const body = await this.post<EmbeddingsResponse>(
              uri.baseUrl,
              "/embeddings",
              { model, input: batch.texts },
            );
            const data = body.data ?? [];
            // Trust nothing about the shape: a truncated or reordered response
            // silently writes wrong vectors into the index, and a wrong-
            // dimension vector corrupts it outright.
            if (data.length !== batch.texts.length) {
              throw new Error(
                `expected ${batch.texts.length} embeddings, got ${data.length}`,
              );
            }
            return data;
          },
          {
            operation: "remote.embedBatch",
            context: { model, batch_size: batch.texts.length },
          },
        );

        rows.forEach((row, i) => {
          const at = typeof row.index === "number" ? row.index : i;
          if (at < 0 || at >= batch.texts.length) return;
          if (!row.embedding?.length) return;
          if (this.expectedDimensions === undefined) {
            this.expectedDimensions = row.embedding.length;
          } else if (row.embedding.length !== this.expectedDimensions) {
            // Mixed dimensions in one index make every later search wrong in a
            // way no error reports, so refuse the vector rather than store it.
            logger.error(
              {
                operation: "remote.embedBatch",
                model,
                expected_dimensions: this.expectedDimensions,
                got_dimensions: row.embedding.length,
              },
              "embedding_dimension_mismatch",
            );
            return;
          }
          out[batch.at + at] = { embedding: row.embedding, model };
        });
      } catch (err) {
        // The batch is lost, but the run continues: one bad batch should not
        // discard thousands of good embeddings. Counted and reported below --
        // never silently absorbed.
        failedBatches++;
        logger.error(
          {
            operation: "remote.embedBatch",
            model,
            batch_offset: batch.at,
            batch_size: batch.texts.length,
            ...errorFields(err),
          },
          "embed_batch_failed",
        );
      }
    };

    // Bounded concurrency: a fixed pool of workers pulling from one queue, so
    // an unbounded input cannot open unbounded sockets.
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.concurrency, batches.length) },
      async () => {
        while (next < batches.length) {
          await runBatch(batches[next++]!);
        }
      },
    );
    await Promise.all(workers);

    const failedTexts = out.filter((e) => e === null).length;
    if (failedTexts > 0) {
      // A partially-failed run that reports success is how an index quietly
      // ends up incomplete, so say so at a level that is visible by default.
      logger.warn(
        {
          operation: "remote.embedBatch",
          model,
          failed_texts: failedTexts,
          total_texts: texts.length,
          failed_batches: failedBatches,
          duration_ms: Date.now() - startedAt,
        },
        "embed_batch_partial_failure",
      );
    } else {
      logger.info(
        {
          operation: "remote.embedBatch",
          model,
          total_texts: texts.length,
          batches: batches.length,
          concurrency: this.concurrency,
          duration_ms: Date.now() - startedAt,
        },
        "embed_batch_ok",
      );
    }
    return out;
  }

  /** Generate a completion via /v1/chat/completions. */
  async generate(
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<GenerateResult | null> {
    const uri = this.require("generate");
    const model = this.wireModel(options.model, uri);
    try {
      return await withRetry(
        async () => {
          const body = await this.post<ChatResponse>(
            uri.baseUrl,
            "/chat/completions",
            {
              model,
              messages: [{ role: "user", content: prompt }],
              max_tokens: options.maxTokens ?? 600,
              temperature: options.temperature ?? 0.7,
            },
          );
          const choice = body.choices?.[0];
          const text = choice?.message?.content;
          if (typeof text !== "string") {
            throw new Error("response contained no message content");
          }
          return {
            text,
            model,
            done: choice?.finish_reason !== "length",
          } satisfies GenerateResult;
        },
        { operation: "remote.generate", context: { model } },
      );
    } catch (err) {
      // Generation drives query expansion, which has a defined fallback: the
      // plain query. Returning null selects it, and the caller degrades to an
      // unexpanded search rather than failing. Logged at error because a
      // degraded search that says nothing is indistinguishable from a good one.
      logger.error(
        { operation: "remote.generate", model, ...errorFields(err) },
        "generate_failed",
      );
      return null;
    }
  }

  /**
   * Report whether the server knows this model.
   *
   * Asks /v1/models rather than assuming: a typo'd model name is the most
   * likely misconfiguration here and the cheapest to catch by name.
   */
  async modelExists(modelUri: string): Promise<ModelInfo> {
    const name = modelIdentity(modelUri);
    const uri = isRemoteModelUri(modelUri)
      ? parseRemoteModelUri(modelUri)
      : (this.embedUri ?? this.generateUri ?? this.rerankUri);
    if (!uri) return { name, exists: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${uri.baseUrl}/models`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new HttpStatusError(
          `${response.status} ${response.statusText}`,
          response.status,
          `${uri.baseUrl}/models`,
        );
      }
      const body = (await response.json()) as { data?: { id?: string }[] };
      const exists = (body.data ?? []).some((m) => m.id === name);
      return { name, exists, path: `${uri.baseUrl}#${name}` };
    } catch (err) {
      // Reports non-existence rather than throwing, because callers use this
      // as a probe. The log is what distinguishes "the server says no" from
      // "the server could not be asked".
      logger.warn(
        { operation: "remote.modelExists", model: name, ...errorFields(err) },
        "model_exists_check_failed",
      );
      return { name, exists: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verify every configured remote role before any work depends on it.
   *
   * Without this the first failure surfaces mid-operation -- partway through a
   * re-index, or on a search the user is waiting for -- and a wrong model name
   * looks identical to a network problem. One round trip up front turns both
   * into a named error before anything starts.
   *
   * @throws If a configured model is not served, or the server cannot be
   *   reached at all.
   */
  async preflight(): Promise<void> {
    const roles: [string, RemoteModelUri | undefined][] = [
      ["embed", this.embedUri],
      ["generate", this.generateUri],
      ["rerank", this.rerankUri],
    ];
    for (const [role, uri] of roles) {
      if (!uri) continue;
      const info = await this.modelExists(`${uri.baseUrl}#${uri.model}`);
      if (!info.exists) {
        throw new Error(
          `Remote ${role} model ${JSON.stringify(uri.model)} is not served by ` +
            `${uri.baseUrl}. Check the model name against that server's ` +
            `/v1/models, and that the server is reachable.`,
        );
      }
      logger.debug(
        { operation: "remote.preflight", role, model: uri.model },
        "preflight_ok",
      );
    }
  }

  /**
   * Rerank documents via /v1/rerank.
   *
   * Parity with LlamaCpp.rerank: results are sorted by descending score and
   * every input document appears exactly once. A server that omits a document
   * scores it 0 rather than dropping it, so callers can rely on the count.
   */
  async rerank(
    query: string,
    documents: RerankDocument[],
    options: RerankOptions = {},
  ): Promise<RerankResult> {
    const uri = this.require("rerank");
    const model = this.wireModel(options.model, uri);
    if (documents.length === 0) return { results: [], model };

    // Fit each document inside one server ubatch. Truncating is what the local
    // path does too (llm.ts rerank): a reranker scores relevance, and the
    // opening of a chunk carries it -- a truncated score beats no score.
    const budgetChars =
      (REMOTE_RERANK_BATCH_TOKENS -
        REMOTE_RERANK_TEMPLATE_OVERHEAD -
        Math.ceil(query.length / CHARS_PER_TOKEN)) *
      CHARS_PER_TOKEN;
    let truncated = 0;
    const texts = documents.map((d) => {
      if (budgetChars > 0 && d.text.length > budgetChars) {
        truncated++;
        return d.text.slice(0, budgetChars);
      }
      return d.text;
    });
    if (truncated > 0) {
      logger.debug(
        {
          operation: "remote.rerank",
          model,
          truncated_documents: truncated,
          budget_chars: budgetChars,
        },
        "rerank_documents_truncated",
      );
    }

    const body = await withRetry(
      () =>
        this.post<RerankResponse>(uri.baseUrl, "/rerank", {
          model,
          query,
          documents: texts,
        }),
      {
        operation: "remote.rerank",
        context: { model, documents: documents.length },
      },
    );

    const scores = new Array(documents.length).fill(0);
    for (const row of body.results ?? []) {
      const at = row.index;
      if (typeof at !== "number" || at < 0 || at >= documents.length) continue;
      scores[at] = row.relevance_score ?? row.score ?? 0;
    }

    const results = documents
      .map((doc, index) => ({ file: doc.file, score: scores[index]!, index }))
      .sort((a, b) => b.score - a.score);
    return { results, model };
  }

  /**
   * Expand a query into lex/vec/hyde variants.
   *
   * The local path constrains output with a GBNF grammar, which the OpenAI
   * API has no equivalent for. The parse below is therefore the only guard,
   * and it is the same one LlamaCpp.expandQuery applies after its grammar:
   * unknown line types are dropped, variants sharing no term with the query
   * are dropped, and an empty result falls back to the query itself. An
   * unconstrained model that drifts degrades to a plain search rather than
   * failing or returning nonsense.
   */
  async expandQuery(
    query: string,
    options: {
      context?: string;
      includeLexical?: boolean;
      intent?: string;
    } = {},
  ): Promise<Queryable[]> {
    const includeLexical = options.includeLexical ?? true;
    const plain: Queryable[] = includeLexical
      ? [
          { type: "lex", text: query },
          { type: "vec", text: query },
        ]
      : [{ type: "vec", text: query }];

    try {
      const prompt = options.intent
        ? `/no_think Expand this search query: ${query}\nQuery intent: ${options.intent}`
        : `/no_think Expand this search query: ${query}`;
      const result = await this.generate(prompt, {
        maxTokens: 600,
        temperature: 0.7,
      });
      if (!result) return plain;

      const queryTerms = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      const hasQueryTerm = (text: string): boolean =>
        queryTerms.length === 0 ||
        queryTerms.some((t) => text.toLowerCase().includes(t));

      const queryables = result.text
        .trim()
        .split("\n")
        .map((line): Queryable | null => {
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) return null;
          const type = line.slice(0, colonIdx).trim();
          if (type !== "lex" && type !== "vec" && type !== "hyde") return null;
          const text = line.slice(colonIdx + 1).trim();
          if (!text || !hasQueryTerm(text)) return null;
          return { type: type as QueryType, text };
        })
        .filter((q): q is Queryable => q !== null);

      const filtered = includeLexical
        ? queryables
        : queryables.filter((q) => q.type !== "lex");
      return filtered.length > 0 ? filtered : plain;
    } catch (err) {
      // Falls back to the unexpanded query -- a documented degraded path, not
      // a swallowed error: search still works, with less recall.
      logger.warn(
        { operation: "remote.expandQuery", ...errorFields(err) },
        "expand_query_degraded",
      );
      return plain;
    }
  }

  /** No persistent resources: every call is a discrete HTTP request. */
  async dispose(): Promise<void> {}
}
