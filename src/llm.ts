/**
 * llm.ts - LLM abstraction layer for QMD.
 *
 * Provides embeddings, text generation, and reranking. Every role is served by
 * a remote llama-server over HTTP: this build carries no in-process inference
 * runtime at all, so a model field naming a local gguf is a configuration
 * error rather than a slower path. See LocalModelsDisabledError.
 */

import { errorFields, logger } from "./logging.js";
import {
  isRemoteModelUri,
  modelIdentity,
  parseRemoteModelUri,
  RemoteLLM,
} from "./remote-llm.js";

export {
  isRemoteModelUri,
  modelIdentity,
  parseRemoteModelUri,
  RemoteLLM,
} from "./remote-llm.js";

/**
 * Raised when something asks for a model that would run in this process.
 *
 * This fork serves every role from a remote server, so a local load is never
 * a slower-but-working fallback: it is a configuration that has silently
 * stopped doing what it says. The failure modes it replaces are both worse
 * than an error -- `qmd embed` handing a `https://` model field to
 * node-llama-cpp, which treats it as something to DOWNLOAD (404, exit 1), and
 * a stripped-to-undefined role falling back to a built-in `hf:` default and
 * embedding locally while reporting success.
 *
 * The message names the role, the URI that produced it, and the one fix,
 * because every instance of this is a config field that needs editing.
 */
/**
 * Rethrow a local-model refusal past a catch that degrades to null.
 *
 * The embed paths treat a per-item failure as "this document did not embed"
 * and continue, which is right for a bad document and wrong for a
 * misconfiguration: every item fails the same way, the run reports partial
 * success, and the operator learns nothing. A configuration error is not a
 * data error, so it must not be absorbed by the data error path.
 */
export function rethrowIfLocalModelsDisabled(err: unknown): void {
  if (err instanceof LocalModelsDisabledError) throw err;
}

export class LocalModelsDisabledError extends Error {
  readonly role: string;
  readonly uri: string | undefined;
  /** CLI exit code, distinct from the generic 1 so scripts can branch on it. */
  static readonly EXIT_CODE = 3;

  constructor(role: string, uri?: string) {
    super(
      `Local models are disabled in this build, but the ${role} role asked ` +
        `to load one${uri ? `: ${JSON.stringify(uri)}` : ""}. ` +
        `Set models.${role} (or QMD_${role.toUpperCase()}_MODEL) to a remote ` +
        `URI of the form https://host/v1#model-name.`,
    );
    this.name = "LocalModelsDisabledError";
    this.role = role;
    this.uri = uri;
  }
}

import { homedir } from "os";
import { join } from "path";
import { existsSync, statSync, openSync, readSync, closeSync } from "fs";

// =============================================================================
// Embedding Formatting Functions
// =============================================================================

/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 * Qwen3-Embedding uses a different prompting style than nomic/embeddinggemma.
 */
export function isQwen3EmbeddingModel(modelUri: string): boolean {
  // Match the model NAME, never the transport. A URL pointing at a qwen
  // embedder has "qwen" nowhere in its host, so testing the raw field would
  // silently pick the wrong prompt format and quietly degrade recall.
  const name = modelIdentity(modelUri);
  return /qwen.*embed/i.test(name) || /embed.*qwen/i.test(name);
}

/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format for embeddinggemma (default).
 * Uses Qwen3-Embedding instruct format when a Qwen embedding model is active.
 */
export function formatQueryForEmbedding(
  query: string,
  modelUri?: string,
): string {
  const uri = modelUri ?? resolveEmbedModel();
  if (isQwen3EmbeddingModel(uri)) {
    return `Instruct: Retrieve relevant documents for the given query\nQuery: ${query}`;
  }
  return `task: search result | query: ${query}`;
}

/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields (default).
 * Qwen3-Embedding encodes documents as raw text without special prefixes.
 */
export function formatDocForEmbedding(
  text: string,
  title?: string,
  modelUri?: string,
): string {
  const uri = modelUri ?? resolveEmbedModel();
  if (isQwen3EmbeddingModel(uri)) {
    // Qwen3-Embedding: documents are raw text, no task prefix
    return title ? `${title}\n${text}` : text;
  }
  return `title: ${title || "none"} | text: ${text}`;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Token with log probability
 */
export type TokenLogProb = {
  token: string;
  logprob: number;
};

/**
 * Embedding result
 */
export type EmbeddingResult = {
  embedding: number[];
  model: string;
};

/**
 * Generation result with optional logprobs
 */
export type GenerateResult = {
  text: string;
  model: string;
  logprobs?: TokenLogProb[];
  done: boolean;
};

/**
 * Rerank result for a single document
 */
export type RerankDocumentResult = {
  file: string;
  score: number;
  index: number;
};

/**
 * Batch rerank result
 */
export type RerankResult = {
  results: RerankDocumentResult[];
  model: string;
};

/**
 * Model info
 */
export type ModelInfo = {
  name: string;
  exists: boolean;
  path?: string;
};

/**
 * Options for embedding
 */
export type EmbedOptions = {
  model?: string;
  isQuery?: boolean;
  title?: string;
};

/**
 * Options for text generation
 */
export type GenerateOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

/**
 * Options for reranking
 */
export type RerankOptions = {
  model?: string;
};

/**
 * Options for LLM sessions
 */
export type LLMSessionOptions = {
  /** Max session duration in ms (default: 10 minutes) */
  maxDuration?: number;
  /** External abort signal */
  signal?: AbortSignal;
  /** Debug name for logging */
  name?: string;
};

/**
 * Session interface for scoped LLM access with lifecycle guarantees
 */
export interface ILLMSession {
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
  embedBatch(
    texts: string[],
    options?: EmbedOptions,
  ): Promise<(EmbeddingResult | null)[]>;
  expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean },
  ): Promise<Queryable[]>;
  rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult>;
  /** Whether this session is still valid (not released or aborted) */
  readonly isValid: boolean;
  /** Abort signal for this session (aborts on release or maxDuration) */
  readonly signal: AbortSignal;
}

/**
 * Supported query types for different search backends
 */
export type QueryType = "lex" | "vec" | "hyde";

/**
 * A single query and its target backend type
 */
export type Queryable = {
  type: QueryType;
  text: string;
};

/**
 * Document to rerank
 */
export type RerankDocument = {
  file: string;
  text: string;
  title?: string;
};

// =============================================================================
// Model Configuration
// =============================================================================

// Remote model URIs: base URL plus the model name the server routes on.
// Format: https://host/v1#model-name -- see parseRemoteModelUri.
//
// This fork runs no model in-process (LocalModelsDisabledError), so the
// defaults must name the server rather than a gguf to download. A fresh
// index.yml therefore pins remote, and a config that omits a role gets a
// working remote one instead of a local load that now throws.
// Override via QMD_EMBED_MODEL / QMD_RERANK_MODEL / QMD_GENERATE_MODEL.
const REMOTE_MODEL_BASE_URL = "https://llama-swap.rodaddy.live/v1";
const DEFAULT_EMBED_MODEL = `${REMOTE_MODEL_BASE_URL}#embed-gemma`;
const DEFAULT_RERANK_MODEL = `${REMOTE_MODEL_BASE_URL}#rerank-qwen3`;
const DEFAULT_GENERATE_MODEL = `${REMOTE_MODEL_BASE_URL}#qmd-query-expansion`;

export const DEFAULT_EMBED_MODEL_URI = DEFAULT_EMBED_MODEL;
export const DEFAULT_RERANK_MODEL_URI = DEFAULT_RERANK_MODEL;
export const DEFAULT_GENERATE_MODEL_URI = DEFAULT_GENERATE_MODEL;

export type ModelResolutionConfig = {
  embed?: string;
  generate?: string;
  rerank?: string;
};

export function resolveEmbedModel(config?: ModelResolutionConfig): string {
  return config?.embed || process.env.QMD_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

export function resolveGenerateModel(config?: ModelResolutionConfig): string {
  return (
    config?.generate || process.env.QMD_GENERATE_MODEL || DEFAULT_GENERATE_MODEL
  );
}

export function resolveRerankModel(config?: ModelResolutionConfig): string {
  return config?.rerank || process.env.QMD_RERANK_MODEL || DEFAULT_RERANK_MODEL;
}

export function resolveModels(
  config?: ModelResolutionConfig,
): Required<ModelResolutionConfig> {
  return {
    embed: resolveEmbedModel(config),
    generate: resolveGenerateModel(config),
    rerank: resolveRerankModel(config),
  };
}

export async function pullModels(models: string[]): Promise<never> {
  // A remote role needs no pull; the server holds the weights. This build
  // cannot download or run a gguf, so the command refuses up front.
  throw new LocalModelsDisabledError("pull", models[0]);
}

// =============================================================================
// LLM Interface
// =============================================================================

/**
 * Abstract LLM interface - implement this for different backends
 */
export interface LLM {
  /**
   * Get embeddings for text
   */
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;

  /**
   * Get embeddings for many texts.
   *
   * On the interface rather than only on the implementations because a remote
   * backend serves a whole batch in one request -- the difference between one
   * HTTP round trip per re-index batch and one per document.
   */
  embedBatch(
    texts: string[],
    options?: EmbedOptions,
  ): Promise<(EmbeddingResult | null)[]>;

  /**
   * Generate text completion
   */
  generate(
    prompt: string,
    options?: GenerateOptions,
  ): Promise<GenerateResult | null>;

  /**
   * Check if a model exists/is available
   */
  modelExists(model: string): Promise<ModelInfo>;

  /**
   * Expand a search query into multiple variations for different backends.
   * Returns a list of Queryable objects.
   */
  expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean; intent?: string },
  ): Promise<Queryable[]>;

  /**
   * Rerank documents by relevance to a query
   * Returns list of documents with relevance scores (higher = more relevant)
   */
  rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult>;

  /**
   * Tokenize text with the embedding model's own tokenizer.
   *
   * On the interface because chunking is sized in tokens and a chunk must be
   * measured by the tokenizer that will actually embed it. store.ts previously
   * reached past this interface to the local backend, which loaded a gguf on a
   * machine whose embed role was remote -- the exact failure the remote
   * backend exists to prevent.
   */
  tokenize(text: string): Promise<readonly number[]>;

  /**
   * Turn token ids back into text, for truncating a chunk to a token budget.
   */
  detokenize(tokens: readonly number[]): Promise<string>;

  /**
   * The embed model field this backend was configured with.
   *
   * On the interface because callers use it to fingerprint stored vectors and
   * to select a prompt format -- both of which must follow the backend that
   * actually computes the embeddings, not a global default.
   */
  readonly embedModelName: string;

  /**
   * The generate and rerank model fields this backend was configured with.
   *
   * Alongside embedModelName for the same reason: callers default a model
   * argument from the active backend, and a default read from a global
   * constant rather than the live backend is how a remote configuration ends
   * up sending `hf:ggml-org/...` to a server that has no such route.
   */
  readonly generateModelName: string;
  readonly rerankModelName: string;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}

// =============================================================================
// Session Management Layer
// =============================================================================

/**
 * Manages LLM session lifecycle with reference counting.
 * Coordinates with LlamaCpp idle timeout to prevent disposal during active sessions.
 */
class LLMSessionManager {
  // Typed to the interface, not the local implementation: a session is a
  // lifecycle wrapper and does not care whether the work happens in-process
  // or over HTTP.
  private llm: LLM;
  private _activeSessionCount = 0;
  private _inFlightOperations = 0;

  constructor(llm: LLM) {
    this.llm = llm;
  }

  get activeSessionCount(): number {
    return this._activeSessionCount;
  }

  get inFlightOperations(): number {
    return this._inFlightOperations;
  }

  /**
   * Returns true only when both session count and in-flight operations are 0.
   * Used by LlamaCpp to determine if idle unload is safe.
   */
  canUnload(): boolean {
    return this._activeSessionCount === 0 && this._inFlightOperations === 0;
  }

  acquire(): void {
    this._activeSessionCount++;
  }

  release(): void {
    this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
  }

  operationStart(): void {
    this._inFlightOperations++;
  }

  operationEnd(): void {
    this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
  }

  getLlamaCpp(): LLM {
    return this.llm;
  }
}

/**
 * Error thrown when an operation is attempted on a released or aborted session.
 */
export class SessionReleasedError extends Error {
  constructor(message = "LLM session has been released or aborted") {
    super(message);
    this.name = "SessionReleasedError";
  }
}

/**
 * Scoped LLM session with automatic lifecycle management.
 * Wraps LlamaCpp methods with operation tracking and abort handling.
 */
class LLMSession implements ILLMSession {
  private manager: LLMSessionManager;
  private released = false;
  private abortController: AbortController;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private name: string;

  constructor(manager: LLMSessionManager, options: LLMSessionOptions = {}) {
    this.manager = manager;
    this.name = options.name || "unnamed";
    this.abortController = new AbortController();

    // Link external abort signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            this.abortController.abort(options.signal!.reason);
          },
          { once: true },
        );
      }
    }

    // Set up max duration timer
    const maxDuration = options.maxDuration ?? 10 * 60 * 1000; // Default 10 minutes
    if (maxDuration > 0) {
      this.maxDurationTimer = setTimeout(() => {
        this.abortController.abort(
          new Error(
            `Session "${this.name}" exceeded max duration of ${maxDuration}ms`,
          ),
        );
      }, maxDuration);
      this.maxDurationTimer.unref(); // Don't keep process alive
    }

    // Acquire session lease
    this.manager.acquire();
  }

  get isValid(): boolean {
    return !this.released && !this.abortController.signal.aborted;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Release the session and decrement ref count.
   * Called automatically by withLLMSession when the callback completes.
   */
  release(): void {
    if (this.released) return;
    this.released = true;

    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }

    this.abortController.abort(new Error("Session released"));
    this.manager.release();
  }

  /**
   * Wrap an operation with tracking and abort checking.
   */
  private async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.isValid) {
      throw new SessionReleasedError();
    }

    this.manager.operationStart();
    try {
      // Check abort before starting
      if (this.abortController.signal.aborted) {
        throw new SessionReleasedError(
          this.abortController.signal.reason?.message || "Session aborted",
        );
      }
      return await fn();
    } finally {
      this.manager.operationEnd();
    }
  }

  async embed(
    text: string,
    options?: EmbedOptions,
  ): Promise<EmbeddingResult | null> {
    return this.withOperation(() =>
      this.manager.getLlamaCpp().embed(text, options),
    );
  }

  async embedBatch(
    texts: string[],
    options?: EmbedOptions,
  ): Promise<(EmbeddingResult | null)[]> {
    return this.withOperation(() =>
      this.manager.getLlamaCpp().embedBatch(texts, options),
    );
  }

  async expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean },
  ): Promise<Queryable[]> {
    return this.withOperation(() =>
      this.manager.getLlamaCpp().expandQuery(query, options),
    );
  }

  async rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    return this.withOperation(() =>
      this.manager.getLlamaCpp().rerank(query, documents, options),
    );
  }
}

// Session manager for the active backend.
let defaultSessionManager: LLMSessionManager | null = null;

// The model configuration sessions are built from. The CLI loads index.yml
// and installs it here, so a session created anywhere in the process routes
// by the user's config rather than by the built-in defaults.
let activeModelConfig: ModelResolutionConfig | undefined;

// Preflight runs once per process, not once per backend build.
let preflightStarted = false;

/**
 * Install the model configuration used for new sessions.
 *
 * Called once by the CLI after reading index.yml. Discards any cached session
 * manager so a configuration change takes effect rather than being masked by
 * a manager built from the previous one.
 */
export function setActiveModelConfig(
  config: ModelResolutionConfig | undefined,
): void {
  activeModelConfig = config;
  // Discard every cached backend: a configuration change that leaves a stale
  // singleton in place is indistinguishable from a change that did nothing.
  defaultSessionManager = null;
  defaultLlamaCpp = null;
  preflightStarted = false;
}

/**
 * Get the session manager for the default LlamaCpp instance.
 */
function getSessionManager(): LLMSessionManager {
  // createLLM validates every configured model field and routes each role to
  // the backend its own field named. This is the single point where the
  // configuration becomes a backend, so a URL cannot be accepted here and
  // then quietly ignored downstream.
  const llm = createLLM(activeModelConfig);
  if (!defaultSessionManager || defaultSessionManager.getLlamaCpp() !== llm) {
    defaultSessionManager = new LLMSessionManager(llm);
  }
  return defaultSessionManager;
}

/**
 * Execute a function with a scoped LLM session.
 * The session provides lifecycle guarantees - resources won't be disposed mid-operation.
 *
 * @example
 * ```typescript
 * await withLLMSession(async (session) => {
 *   const expanded = await session.expandQuery(query);
 *   const embeddings = await session.embedBatch(texts);
 *   const reranked = await session.rerank(query, docs);
 *   return reranked;
 * }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
 * ```
 */
export async function withLLMSession<T>(
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions,
): Promise<T> {
  const manager = getSessionManager();
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Execute a function with a scoped LLM session using a specific LlamaCpp instance.
 * Unlike withLLMSession, this does not use the global singleton.
 */
export async function withLLMSessionForLlm<T>(
  llm: LLM,
  fn: (session: ILLMSession) => Promise<T>,
  options?: LLMSessionOptions,
): Promise<T> {
  const manager = new LLMSessionManager(llm);
  const session = new LLMSession(manager, options);

  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Check if idle unload is safe (no active sessions or operations).
 * Used internally by LlamaCpp idle timer.
 */
export function canUnloadLLM(): boolean {
  if (!defaultSessionManager) return true;
  return defaultSessionManager.canUnload();
}

// =============================================================================
// Darwin Metal exit-crash mitigation
// =============================================================================
//
// libggml-metal on macOS keeps allocated model memory wired via "residency
// sets" with a 180-second keep_alive timer (added in ggml-org/llama.cpp#11427).
// The process-static `std::vector<std::unique_ptr<ggml_metal_device>>`
// destructor fires during libc `exit()` → `__cxa_finalize_ranges` and asserts
// `[rsets->data count] == 0` — but the keep_alive hasn't expired, so the
// assertion fails and `ggml_abort` dumps a multi-kilobyte stack trace to
// stderr after the user-visible output. See ggml-org/llama.cpp#22593.
//
// No JS-side dispose call (`llama.dispose()`, `model.dispose()`, etc.) can
// prevent it: the static destructor runs after every JS-reachable cleanup,
// and `process.reallyExit` on Node calls libc `exit()` not `_exit()` (it
// does NOT skip C++ static destructors — verified in
// node/src/api/environment.cc).
//
// The actual fix is to disable residency sets via `GGML_METAL_NO_RESIDENCY=1`,
// which we set from `bin/qmd` before Node loads the native binding. For QMD's
// short-lived CLI workflow this has no measurable cost (subsequent calls
// don't reuse the warm mapping). The functions below report whether that
// mitigation is in effect — kept here, in the module that depends on the
// underlying resource, so doctor can answer "is the protection active?"
// without reaching into env handling directly.
//
// Setting `QMD_METAL_KEEP_RESIDENCY=1` opts back into residency sets (with
// the visible-noise consequences). The legacy `QMD_DISABLE_DARWIN_SAFE_EXIT`
// env var is accepted as a no-op alias for back-compat; it had no effect on
// Node prior to this fix.

/**
 * Whether QMD's darwin Metal exit-crash mitigation is active in this process:
 *   true  → residency sets disabled, process exit completes silently
 *   false → either non-darwin, or `QMD_METAL_KEEP_RESIDENCY=1` overrode it,
 *           in which case the libggml-metal teardown assertion may fire
 */
export function isDarwinMetalMitigationActive(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.env.QMD_METAL_KEEP_RESIDENCY === "1") return false;
  return process.env.GGML_METAL_NO_RESIDENCY === "1";
}

// =============================================================================
// Singleton for default LlamaCpp instance
// =============================================================================

let defaultLlamaCpp: LLM | null = null;

/**
 * Get the default backend, building it from the active configuration.
 *
 * THIS IS THE ONE PLACE A BACKEND IS CHOSEN. Every caller in store.ts,
 * index.ts and the CLI funnels through here, so the decision is made once and
 * nothing downstream re-derives it. Previously this hardcoded `new LlamaCpp()`
 * regardless of configuration, which is why a `models.embed` naming a remote
 * server was accepted, echoed back, and then ignored: the config never reached
 * the object that did the work.
 *
 * When the configuration names a remote server for every role, no LlamaCpp is
 * constructed at all -- node-llama-cpp is never loaded and no model is
 * resident locally, which is the entire point of pointing qmd at a GPU box.
 */
export function getDefaultLlamaCpp(): LLM {
  if (!defaultLlamaCpp) {
    defaultLlamaCpp = buildBackendFromConfig(activeModelConfig);
  }
  return defaultLlamaCpp;
}

/**
 * The local backend, which no longer exists.
 *
 * This build ships no in-process inference runtime, so there is nothing to
 * return: every call site that used to reach a local model is now a
 * configuration that names a gguf on a build that cannot open one. Refusing
 * here rather than returning a stub keeps the failure at the point the role
 * is known, which is what makes the message name the field to edit.
 *
 * Kept as a function rather than deleted outright because it is the seam the
 * role-routing code checks; removing it would push the same decision out to
 * each caller, which is how a local path got reached past the factory before.
 */
function refuseLocalBackend(
  role: string,
  models?: Required<ModelResolutionConfig>,
): never {
  const uri = models?.[role as keyof Required<ModelResolutionConfig>];
  throw new LocalModelsDisabledError(role, uri);
}

/** A local model is never available in this build; report it, do not throw. */
function localModelAbsent(model: string): ModelInfo {
  return { name: modelIdentity(model), exists: false };
}

/**
 * The backend for a configuration whose every role names a local model.
 *
 * Exists so `createLLM` stays total: commands that never touch a model must
 * still get an object back, and the operation that DOES touch one must fail
 * naming its own role. A configuration this wrong is worth an error at the
 * first embed, not at `qmd status`.
 */
class LocalOnlyLLM implements LLM {
  constructor(private readonly models: Required<ModelResolutionConfig>) {}

  get embedModelName(): string {
    return this.models.embed;
  }

  get generateModelName(): string {
    return this.models.generate;
  }

  get rerankModelName(): string {
    return this.models.rerank;
  }

  async embed(): Promise<EmbeddingResult | null> {
    refuseLocalBackend("embed", this.models);
  }

  async embedBatch(): Promise<(EmbeddingResult | null)[]> {
    refuseLocalBackend("embed", this.models);
  }

  async generate(): Promise<GenerateResult | null> {
    refuseLocalBackend("generate", this.models);
  }

  async expandQuery(): Promise<Queryable[]> {
    refuseLocalBackend("generate", this.models);
  }

  async rerank(): Promise<RerankResult> {
    refuseLocalBackend("rerank", this.models);
  }

  async tokenize(): Promise<readonly number[]> {
    refuseLocalBackend("embed", this.models);
  }

  async detokenize(): Promise<string> {
    refuseLocalBackend("embed", this.models);
  }

  modelExists(model: string): Promise<ModelInfo> {
    return Promise.resolve(localModelAbsent(model));
  }

  async dispose(): Promise<void> {
    // Nothing was ever loaded.
  }
}

/**
 * Turn a configuration into the backend it describes.
 *
 * Validates every role first: a model field qmd cannot parse is a
 * configuration error the user must see, never a silent fall back to local.
 */
function buildBackendFromConfig(config?: ModelResolutionConfig): LLM {
  const models = resolveModels(config);
  assertKnownModelScheme(models.embed, "embed");
  assertKnownModelScheme(models.generate, "generate");
  assertKnownModelScheme(models.rerank, "rerank");

  const remoteRoles = [models.embed, models.generate, models.rerank].filter(
    isRemoteModelUri,
  );
  // Every role names a local model and this build has no local runtime. The
  // refusal is deliberately deferred to the first operation rather than thrown
  // here: the factory runs for commands that never touch a model (`qmd status`,
  // `qmd ls`), and failing at construction would take those down too. Deferring
  // also puts the error where the role is known, so the message can name the
  // field to edit.
  if (remoteRoles.length === 0) return new LocalOnlyLLM(models);

  const remote = new RemoteLLM({
    embedModel: isRemoteModelUri(models.embed) ? models.embed : undefined,
    generateModel: isRemoteModelUri(models.generate)
      ? models.generate
      : undefined,
    rerankModel: isRemoteModelUri(models.rerank) ? models.rerank : undefined,
  });

  // Check the server knows every model we are about to ask it for, once per
  // process, without blocking this synchronous factory. A wrong model name and
  // an unreachable host otherwise surface partway through a re-index, where
  // they look like a transient network problem rather than a typo. Failure is
  // reported, not thrown: the operation needing the model fails on its own with
  // its own context, and aborting here would take down commands (`qmd status`)
  // that never touch a model.
  if (!preflightStarted) {
    preflightStarted = true;
    void remote.preflight().catch((err: unknown) => {
      logger.error(
        { operation: "remote.preflight", ...errorFields(err) },
        "preflight_failed",
      );
    });
  }

  if (remoteRoles.length === 3) return remote;
  return new HybridLLM(remote, models);
}

/**
 * Reject a model field that is neither a local model nor a remote URL.
 *
 * qmd 2.6.3 accepted any string here and passed anything it did not recognise
 * to node-llama-cpp, which treated it as a local path. A typo'd or half-migrated
 * URL therefore produced working search results computed entirely locally --
 * configured, apparently fine, and doing something other than what it said. A
 * config that lies is worse than one that breaks, so an unrecognised scheme
 * now throws by name.
 */
export function assertKnownModelScheme(uri: string, role: string): void {
  if (!isRemoteModelUri(uri)) return; // hf:, a path, or a bare name: local, as always
  // A URL routes to a remote server, and a remote server needs a model name.
  // Without one the request would be sent with the URL itself as the model and
  // rejected as "no router for requested model" -- a confusing failure a long
  // way from its cause, so name it here instead.
  parseRemoteModelUri(uri);
}

/**
 * Whether the active configuration routes any role to a remote server.
 */
export function usesRemoteBackend(config?: ModelResolutionConfig): boolean {
  const models = resolveModels(config);
  return (
    isRemoteModelUri(models.embed) ||
    isRemoteModelUri(models.generate) ||
    isRemoteModelUri(models.rerank)
  );
}

/**
 * Build the LLM backend for a configuration, validating every role first.
 *
 * Roles are independent: embeddings can run on a GPU box while query expansion
 * stays local. When every remote role shares one base URL a single RemoteLLM
 * serves them; a mixed configuration keeps the local instance for the roles
 * that named a local model.
 */
export function createLLM(config?: ModelResolutionConfig): LLM {
  return config === undefined
    ? getDefaultLlamaCpp()
    : buildBackendFromConfig(config);
}

/**
 * Routes each role to whichever backend its own model field named.
 *
 * Exists so a partial migration is a first-class configuration rather than an
 * all-or-nothing switch: embeddings move to the GPU box on their own, and the
 * local generate/rerank models keep working untouched.
 */
class HybridLLM implements LLM {
  constructor(
    private readonly remote: RemoteLLM,
    private readonly models: Required<ModelResolutionConfig>,
  ) {}

  /**
   * A mixed configuration used to keep the local backend for the roles that
   * named a local model. With no local runtime that role has no backend at
   * all, so it gets one that refuses by name rather than silently borrowing
   * the remote one -- which would compute with a model the operator never
   * configured.
   *
   * Returns a refusing backend instead of throwing here: these methods are
   * typed to return a Promise, and a synchronous throw from one skips every
   * caller that handles failure with `.catch`.
   */
  private backend(role: "embed" | "generate" | "rerank"): LLM {
    if (isRemoteModelUri(this.models[role])) return this.remote;
    return new LocalOnlyLLM(this.models);
  }

  get embedModelName(): string {
    return this.models.embed;
  }

  get generateModelName(): string {
    return this.models.generate;
  }

  get rerankModelName(): string {
    return this.models.rerank;
  }

  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.backend("embed").embed(text, options);
  }

  embedBatch(
    texts: string[],
    options?: EmbedOptions,
  ): Promise<(EmbeddingResult | null)[]> {
    return this.backend("embed").embedBatch(texts, options);
  }

  generate(
    prompt: string,
    options?: GenerateOptions,
  ): Promise<GenerateResult | null> {
    return this.backend("generate").generate(prompt, options);
  }

  rerank(
    query: string,
    documents: RerankDocument[],
    options?: RerankOptions,
  ): Promise<RerankResult> {
    return this.backend("rerank").rerank(query, documents, options);
  }

  expandQuery(
    query: string,
    options?: { context?: string; includeLexical?: boolean; intent?: string },
  ): Promise<Queryable[]> {
    return this.backend("generate").expandQuery(query, options);
  }

  /**
   * A probe, not a compute path, so a local model reports absent rather than
   * throwing: "can this build use this model?" has a true answer, and it is
   * no. Callers use this to decide whether to attempt work; raising here
   * would turn a diagnostic into a failure.
   */
  modelExists(model: string): Promise<ModelInfo> {
    if (isRemoteModelUri(model)) return this.remote.modelExists(model);
    return Promise.resolve(localModelAbsent(model));
  }

  /**
   * Tokenization follows the EMBED role specifically, not the generic
   * backend: chunk sizes must be measured by the tokenizer of the model that
   * will embed the chunk, even in a split configuration where generate or
   * rerank live on the other side.
   */
  tokenize(text: string): Promise<readonly number[]> {
    return this.backend("embed").tokenize(text);
  }

  detokenize(tokens: readonly number[]): Promise<string> {
    return this.backend("embed").detokenize(tokens);
  }

  async dispose(): Promise<void> {
    await this.remote.dispose();
  }
}

/**
 * Set a custom default backend (useful for testing). Passing null clears it,
 * so the next getDefaultLlamaCpp() rebuilds from the active configuration.
 */
export function setDefaultLlamaCpp(llm: LLM | null): void {
  defaultLlamaCpp = llm;
}

/**
 * Peek at the default LlamaCpp instance without instantiating one. Used by
 * doctor and lifecycle diagnostics.
 */
export function hasDefaultLlamaCpp(): boolean {
  return defaultLlamaCpp !== null;
}

/**
 * Dispose the default LlamaCpp instance if it exists.
 * Call this before process exit to prevent NAPI crashes.
 */
export async function disposeDefaultLlamaCpp(): Promise<void> {
  if (defaultLlamaCpp) {
    await defaultLlamaCpp.dispose();
    defaultLlamaCpp = null;
  }
}
