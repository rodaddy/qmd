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
};

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_EMBED_BATCH_SIZE = 32;

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
    this.embedBatchSize = config.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
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
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `timed out after ${this.requestTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new Error(`Remote LLM request to ${url} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `Remote LLM request to ${url} returned ${response.status} ` +
          `${response.statusText}${detail ? `: ${detail}` : ""}`,
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
    const out: (EmbeddingResult | null)[] = [];

    for (let start = 0; start < texts.length; start += this.embedBatchSize) {
      const slice = texts.slice(start, start + this.embedBatchSize);
      try {
        const body = await this.post<EmbeddingsResponse>(
          uri.baseUrl,
          "/embeddings",
          {
            model,
            input: slice,
          },
        );
        const rows = body.data ?? [];
        if (rows.length !== slice.length) {
          throw new Error(
            `expected ${slice.length} embeddings, server returned ${rows.length}`,
          );
        }
        // Index is authoritative when present: the spec permits any order.
        const ordered: (EmbeddingResult | null)[] = new Array(
          slice.length,
        ).fill(null);
        rows.forEach((row, i) => {
          const at = typeof row.index === "number" ? row.index : i;
          if (at < 0 || at >= slice.length) return;
          ordered[at] = row.embedding
            ? { embedding: row.embedding, model }
            : null;
        });
        out.push(...ordered);
      } catch (err) {
        console.error(
          `Remote batch embedding failed for ${slice.length} texts:`,
          err instanceof Error ? err.message : err,
        );
        out.push(...slice.map(() => null));
      }
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
      if (typeof text !== "string") return null;
      return { text, model, done: choice?.finish_reason !== "length" };
    } catch (err) {
      console.error(
        "Remote generation failed:",
        err instanceof Error ? err.message : err,
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
    try {
      const response = await fetch(`${uri.baseUrl}/models`, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) return { name, exists: false };
      const body = (await response.json()) as { data?: { id?: string }[] };
      const exists = (body.data ?? []).some((m) => m.id === name);
      return { name, exists, path: `${uri.baseUrl}#${name}` };
    } catch {
      return { name, exists: false };
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

    const body = await this.post<RerankResponse>(uri.baseUrl, "/rerank", {
      model,
      query,
      documents: documents.map((d) => d.text),
    });

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
      console.error(
        "Remote query expansion failed:",
        err instanceof Error ? err.message : err,
      );
      return plain;
    }
  }

  /** No persistent resources: every call is a discrete HTTP request. */
  async dispose(): Promise<void> {}
}
