/**
 * QMD MCP server — 2026-07-28 revision (SDK v2, stateless streamable HTTP).
 *
 * This module is ADDITIVE. `src/mcp/server.ts` keeps serving the 2025-06-18
 * sessionful transport exactly as it did; nothing in it is rewritten. The two
 * eras run side by side behind one `/mcp` endpoint, routed by the SDK's own
 * `isLegacyRequest` predicate:
 *
 *     POST /mcp  ── isLegacyRequest? ──yes──> existing sessionful v1 wiring
 *                                     └─no──> createMcpHandler(..., legacy: 'reject')
 *
 * Routing on the SDK's exported predicate rather than a hand-rolled sniff is
 * deliberate: it runs the same code `createMcpHandler` runs internally, so the
 * split can never disagree with the entry point about which era a request is.
 *
 * The 2026-07-28 leg is per-request: `buildServer` runs on every call, there is
 * no `Mcp-Session-Id`, and GET/DELETE on the modern path answer 405. The shared
 * `QMDStore` is created ONCE by the caller and closed over — it is stateless
 * SQLite and safe for concurrent reads, so it must not be rebuilt per request.
 */

import {
  createMcpHandler,
  isLegacyRequest,
  isJsonContentType,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  extractSnippet,
  addLineNumbers,
  DEFAULT_MULTI_GET_MAX_BYTES,
  type QMDStore,
  type ExpandedQuery,
} from "../index.js";

/** The wire revision this module serves. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * Cache hints for the 2026-07-28 revision. `cacheScope` is `'public' |
 * 'private'` — an invalid value throws a RangeError at McpServer construction.
 *
 * `tools/list` is `public`: the tool roster is identical for every caller, so a
 * shared cache may hold it. It is NOT derived from user documents. Everything
 * that reads the index (`resources/read`) is left at the conservative default,
 * because document content is caller-scoped and must not land in a shared cache.
 */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 60_000, cacheScope: "public" },
} as const;

function encodeQmdPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Tool input schemas.
 *
 * `.strict()` — i.e. `additionalProperties: false` — is OUR standard, not a
 * spec requirement. The 2026-07-28 revision actually LOOSENS schemas (SEP-2106
 * permits any JSON Schema 2020-12 keyword) and only *recommends*
 * `additionalProperties: false` for the no-parameter case. We apply it
 * everywhere anyway: an undeclared property is far more often a caller bug or a
 * silently-dropped rename than an intentional extension, and failing loudly
 * beats ignoring it.
 */
const subSearchSchema = z
  .object({
    type: z
      .enum(["lex", "vec", "hyde"])
      .describe(
        'lex = BM25 keywords (supports "phrase" and -negation); ' +
          "vec = semantic question; hyde = hypothetical answer passage",
      ),
    query: z
      .string()
      .describe(
        'The query text. For lex: use keywords, "quoted phrases", and -negation. ' +
          "For vec: natural language question. For hyde: 50-100 word answer passage.",
      ),
  })
  .strict();

const querySchema = z
  .object({
    searches: z
      .array(subSearchSchema)
      .min(1)
      .max(10)
      .describe(
        "Typed sub-queries to execute (lex/vec/hyde). First gets 2x weight.",
      ),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max results (default: 10)"),
    minScore: z
      .number()
      .optional()
      .default(0)
      .describe("Min relevance 0-1 (default: 0)"),
    candidateLimit: z
      .number()
      .optional()
      .describe("Maximum candidates to rerank (default: 40)"),
    collections: z
      .array(z.string())
      .optional()
      .describe("Filter to collections (OR match)"),
    intent: z
      .string()
      .optional()
      .describe("Background context to disambiguate the query."),
    rerank: z
      .boolean()
      .optional()
      .default(true)
      .describe("Rerank results using LLM (default: true)."),
  })
  .strict();

const getSchema = z
  .object({
    file: z
      .string()
      .describe(
        "File path or docid from search results (e.g. 'pages/meeting.md', '#abc123', or 'pages/meeting.md:100').",
      ),
    fromLine: z
      .number()
      .optional()
      .describe("Start from this line number (1-indexed)"),
    maxLines: z
      .number()
      .optional()
      .describe("Maximum number of lines to return"),
    lineNumbers: z
      .boolean()
      .optional()
      .default(false)
      .describe("Add line numbers to output (format: 'N: content')"),
  })
  .strict();

const multiGetSchema = z
  .object({
    pattern: z
      .string()
      .describe("Glob pattern or comma-separated list of file paths"),
    maxLines: z.number().optional().describe("Maximum lines per file"),
    maxBytes: z
      .number()
      .optional()
      .default(10240)
      .describe("Skip files larger than this (default: 10240 = 10KB)"),
    lineNumbers: z
      .boolean()
      .optional()
      .default(false)
      .describe("Add line numbers to output (format: 'N: content')"),
  })
  .strict();

/**
 * `status` takes no arguments. Per the tools spec this is exactly the case
 * where `additionalProperties: false` is the RECOMMENDED shape — it accepts
 * only the empty object rather than silently swallowing anything sent.
 */
const statusSchema = z.object({}).strict();

/**
 * Build a v2 `McpServer` with QMD's tools registered.
 *
 * Called once per modern request by `createMcpHandler`, so it must stay cheap:
 * it registers handlers and touches no I/O. The `store` is the caller's shared
 * instance and is neither opened nor closed here.
 */
export function buildModernServer(
  store: QMDStore,
  options: {
    version: string;
    instructions?: string;
    defaultCollections: string[];
  },
): McpServer {
  const server = new McpServer(
    { name: "qmd", version: options.version },
    {
      capabilities: { tools: {}, resources: {} },
      ...(options.instructions ? { instructions: options.instructions } : {}),
      cacheHints: CACHE_HINTS,
    },
  );

  server.registerTool(
    "query",
    {
      title: "Query",
      description:
        "Search the knowledge base using one or more typed sub-queries (lex/vec/hyde) combined for best recall.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: querySchema,
    },
    async ({ searches, limit, minScore, collections, intent, rerank }) => {
      const queries: ExpandedQuery[] = searches.map((s) => ({
        type: s.type,
        query: s.query,
      }));
      const effectiveCollections = collections ?? options.defaultCollections;

      // `candidateLimit` is accepted by the schema but deliberately NOT
      // forwarded, because `SearchOptions` has no such field — `store.search`
      // would ignore it. The v1 handler behaves identically (it destructures
      // the value and drops it), so the two eras agree. Passing it surfaced a
      // type error, which is how the pre-existing gap was found: the parameter
      // is advertised to callers and has no effect in either era. Filed rather
      // than fixed here — changing search semantics is outside this cutover.
      const results = await store.search({
        queries,
        collections:
          effectiveCollections.length > 0 ? effectiveCollections : undefined,
        limit,
        minScore,
        intent,
        rerank,
      });

      const primaryQuery =
        searches.find((s) => s.type === "lex")?.query ||
        searches.find((s) => s.type === "vec")?.query ||
        searches[0]?.query ||
        "";

      const formatted = results.map((r) => {
        const { line, snippet } = extractSnippet(
          r.body,
          String(primaryQuery),
          300,
          r.bestChunkPos,
          r.bestChunk.length,
          intent,
        );
        return {
          docid: `#${r.docid}`,
          file: `qmd://${encodeQmdPath(r.displayPath)}`,
          title: r.title,
          score: Math.round(r.score * 100) / 100,
          context: r.context,
          line,
          snippet: addLineNumbers(snippet, line),
        };
      });

      // Structured content is accompanied by the serialized JSON in a text
      // block: the spec's backward-compatibility SHOULD for clients that do
      // not read `structuredContent`.
      return {
        content: [
          { type: "text", text: JSON.stringify({ results: formatted }) },
        ],
        structuredContent: { results: formatted },
      };
    },
  );

  server.registerTool(
    "get",
    {
      title: "Get Document",
      description:
        "Retrieve the full content of a document by its file path or docid.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: getSchema,
    },
    async ({ file, fromLine, maxLines, lineNumbers }) => {
      let parsedFromLine = fromLine;
      let lookup = file;
      const colonMatch = lookup.match(/:(\d+)$/);
      if (colonMatch && colonMatch[1] && parsedFromLine === undefined) {
        parsedFromLine = parseInt(colonMatch[1], 10);
        lookup = lookup.slice(0, -colonMatch[0].length);
      }

      const result = await store.get(lookup, { includeBody: false });

      if ("error" in result) {
        // Tool execution error, NOT a protocol error. A missing document is
        // something the model can act on — it can retry with one of the
        // suggested paths — so it travels in the result channel with
        // `isError: true`. Raising it as a JSON-RPC error would strip that.
        let msg = `Document not found: ${file}`;
        if (result.similarFiles.length > 0) {
          msg += `\n\nDid you mean one of these?\n${result.similarFiles
            .map((s) => `  - ${s}`)
            .join("\n")}`;
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }

      const body =
        (await store.getDocumentBody(result.filepath, {
          fromLine: parsedFromLine,
          maxLines,
        })) ?? "";
      let text = body;
      if (lineNumbers) text = addLineNumbers(text, parsedFromLine || 1);
      if (result.context)
        text = `<!-- Context: ${result.context} -->\n\n` + text;

      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: `qmd://${encodeQmdPath(result.displayPath)}`,
              name: result.displayPath,
              title: result.title,
              mimeType: "text/markdown",
              text,
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    "multi_get",
    {
      title: "Multi-Get Documents",
      description:
        "Retrieve multiple documents by glob pattern or comma-separated list.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: multiGetSchema,
    },
    async ({ pattern, maxLines, maxBytes, lineNumbers }) => {
      const { docs, errors } = await store.multiGet(pattern, {
        includeBody: true,
        maxBytes: maxBytes || DEFAULT_MULTI_GET_MAX_BYTES,
      });

      if (docs.length === 0 && errors.length === 0) {
        return {
          content: [
            { type: "text", text: `No files matched pattern: ${pattern}` },
          ],
          isError: true,
        };
      }

      const content: (
        | { type: "text"; text: string }
        | {
            type: "resource";
            resource: {
              uri: string;
              name: string;
              title?: string;
              mimeType: string;
              text: string;
            };
          }
      )[] = [];

      if (errors.length > 0) {
        content.push({ type: "text", text: `Errors:\n${errors.join("\n")}` });
      }

      for (const result of docs) {
        if (result.skipped) {
          content.push({
            type: "text",
            text: `[SKIPPED: ${result.doc.displayPath} - ${result.skipReason}. Use 'get' with file="${result.doc.displayPath}" to retrieve.]`,
          });
          continue;
        }

        let text = result.doc.body || "";
        if (maxLines !== undefined) {
          const lines = text.split("\n");
          text = lines.slice(0, maxLines).join("\n");
          if (lines.length > maxLines) {
            text += `\n\n[... truncated ${lines.length - maxLines} more lines]`;
          }
        }
        if (lineNumbers) text = addLineNumbers(text);
        if (result.doc.context) {
          text = `<!-- Context: ${result.doc.context} -->\n\n` + text;
        }

        content.push({
          type: "resource",
          resource: {
            uri: `qmd://${encodeQmdPath(result.doc.displayPath)}`,
            name: result.doc.displayPath,
            title: result.doc.title,
            mimeType: "text/markdown",
            text,
          },
        });
      }

      return { content };
    },
  );

  server.registerTool(
    "status",
    {
      title: "Index Status",
      description:
        "Show the status of the QMD index: collections, document counts, and health information.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: statusSchema,
    },
    async () => {
      const status = await store.getStatus();
      const summary = [
        `QMD Index Status:`,
        `  Total documents: ${status.totalDocuments}`,
        `  Needs embedding: ${status.needsEmbedding}`,
        `  Vector index: ${status.hasVectorIndex ? "yes" : "no"}`,
        `  Collections: ${status.collections.length}`,
      ];
      for (const col of status.collections) {
        summary.push(`    - ${col.name}: ${col.path} (${col.documents} docs)`);
      }
      return {
        content: [{ type: "text", text: summary.join("\n") }],
        structuredContent: status as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

/**
 * Create the modern (2026-07-28) HTTP handler.
 *
 * `legacy: 'reject'` is deliberate and is NOT "we dropped 2025 support" — the
 * existing sessionful v1 wiring keeps serving 2025 traffic and the caller
 * routes to it on `isLegacyRequest`. Leaving the default `'stateless'` here
 * would give us a SECOND, session-less 2025 implementation competing with the
 * real one, which is the sibling-path failure mode: two code paths for one
 * concept, drifting apart.
 *
 * `responseMode: 'json'` matches the v1 transport's `enableJsonResponse: true`.
 * QMD's tools emit no mid-call progress notifications, so nothing is dropped.
 */
export function createModernHandler(
  store: QMDStore,
  options: {
    version: string;
    instructions?: string;
    defaultCollections: string[];
  },
  onerror?: (error: Error) => void,
): McpHttpHandler {
  return createMcpHandler(() => buildModernServer(store, options), {
    legacy: "reject",
    responseMode: "json",
    ...(onerror ? { onerror } : {}),
  });
}

export { isLegacyRequest, isJsonContentType };
