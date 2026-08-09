/**
 * MCP 2026-07-28 (SDK v2) conformance tests.
 *
 * These assert the WIRE behaviour of the modern leg: stateless per-request
 * serving, required header validation, strict tool schemas, and the two error
 * channels. They drive `createModernHandler`'s fetch face directly rather than
 * binding a socket, so they need no port and cannot collide with a running
 * server.
 *
 * The store is a stub: nothing here exercises search quality, only protocol
 * shape. Behavioural coverage of the tools themselves lives in mcp.test.ts.
 */

import { describe, test, expect } from "vitest";
import {
  createModernHandler,
  MODERN_PROTOCOL_VERSION,
} from "../src/mcp/server-v2.js";
import type { QMDStore } from "../src/index.js";

const PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;
const URL_ = "http://localhost/mcp";

/**
 * Minimal QMDStore stand-in. Only the methods the tools call are implemented;
 * anything else throws loudly rather than silently returning undefined.
 */
function makeStubStore(): QMDStore {
  const stub = {
    getStatus: async () => ({
      totalDocuments: 2,
      needsEmbedding: 0,
      hasVectorIndex: true,
      collections: [
        {
          name: "fixture",
          path: "/fixture",
          pattern: "**/*.md",
          documents: 2,
          lastUpdated: "2026-08-09T00:00:00.000Z",
        },
      ],
    }),
    search: async () => [],
    get: async () => ({ error: "not_found", similarFiles: ["docs/readme.md"] }),
    getDocumentBody: async () => "",
    multiGet: async () => ({ docs: [], errors: [] }),
    getDefaultCollectionNames: async () => ["fixture"],
    close: async () => {},
  };
  return stub as unknown as QMDStore;
}

function handler() {
  return createModernHandler(makeStubStore(), {
    version: "test",
    defaultCollections: ["fixture"],
  });
}

/** Build a spec-conforming 2026-07-28 POST. */
function modernPost(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  overrideHeaders: Record<string, string> = {},
): Request {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "vitest",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": method,
    ...overrideHeaders,
  };
  const name = params.name ?? params.uri;
  if (name && !("Mcp-Name" in overrideHeaders))
    headers["Mcp-Name"] = String(name);
  return new Request(URL_, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("MCP 2026-07-28 wire conformance", () => {
  test("one-shot tools/call succeeds with no handshake and no session", async () => {
    const h = handler();
    const res = await h.fetch(
      modernPost(1, "tools/call", { name: "status", arguments: {} }),
    );
    expect(res.status).toBe(200);

    // The headline property of the revision: nothing ties the request to a
    // worker, so no session may be minted.
    expect(res.headers.get("mcp-session-id")).toBeNull();

    const json = await res.json();
    expect(json.error).toBeUndefined();
    expect(json.result).toBeDefined();
    // `resultType` is new and REQUIRED on this revision.
    expect(json.result.resultType).toBe("complete");
    await h.close();
  });

  test("Mcp-Name disagreeing with the body is rejected 400 / -32020", async () => {
    const h = handler();
    const res = await h.fetch(
      modernPost(
        2,
        "tools/call",
        { name: "status", arguments: {} },
        { "Mcp-Name": "not_the_body_value" },
      ),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    // -32020 HeaderMismatch, NOT the pre-renumbering -32001.
    expect(json.error.code).toBe(-32020);
    await h.close();
  });

  test("every tool advertises a strict inputSchema", async () => {
    const h = handler();
    const res = await h.fetch(modernPost(3, "tools/list"));
    expect(res.status).toBe(200);
    const json = await res.json();
    const tools = json.result.tools as {
      name: string;
      inputSchema: Record<string, unknown>;
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get",
      "multi_get",
      "query",
      "status",
    ]);

    // additionalProperties:false is OUR standard, not a spec requirement — the
    // 2026-07-28 revision actually loosens schemas. This test is what stops a
    // newly added tool from quietly defaulting to permissive.
    for (const tool of tools) {
      expect(
        tool.inputSchema.additionalProperties,
        `${tool.name} must set additionalProperties:false`,
      ).toBe(false);
    }
    await h.close();
  });

  test("GET is answered 405 — this revision has no standalone stream", async () => {
    const h = handler();
    const res = await h.fetch(
      new Request(URL_, {
        method: "GET",
        headers: { "MCP-Protocol-Version": PROTOCOL_VERSION },
      }),
    );
    expect(res.status).toBe(405);
    await h.close();
  });

  test("an unknown tool is a PROTOCOL error, not an isError result", async () => {
    const h = handler();
    const res = await h.fetch(
      modernPost(5, "tools/call", { name: "no_such_tool", arguments: {} }),
    );
    const json = await res.json();
    expect(json.error?.code).toBe(-32602);
    expect(json.result).toBeUndefined();
    await h.close();
  });

  test("a missing document is a TOOL error the model can retry", async () => {
    // The channel matters: routing this to the protocol channel would strip the
    // model of its ability to self-correct from the suggested paths.
    const h = handler();
    const res = await h.fetch(
      modernPost(6, "tools/call", {
        name: "get",
        arguments: { file: "nope.md" },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("Document not found");
    await h.close();
  });

  test("an undeclared property is rejected by the strict schema", async () => {
    const h = handler();
    const res = await h.fetch(
      modernPost(7, "tools/call", {
        name: "status",
        arguments: { totally_undeclared: 1 },
      }),
    );
    const json = await res.json();
    // Which channel this lands in is decided by the SDK's validation layer, not
    // by the spec, so this asserts only that it is REJECTED rather than
    // silently accepted — the point of the strict schema.
    const rejected = Boolean(json.error) || json.result?.isError === true;
    expect(rejected).toBe(true);
    await h.close();
  });

  test("a legacy initialize is NOT served by the modern leg", async () => {
    // legacy:'reject' is what keeps the 2025 era owned by the existing
    // sessionful wiring instead of a second, session-less implementation.
    const h = handler();
    const res = await h.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "legacy", version: "1.0.0" },
          },
        }),
      }),
    );
    const json = await res.json();
    expect(json.error).toBeDefined();
    await h.close();
  });
});
