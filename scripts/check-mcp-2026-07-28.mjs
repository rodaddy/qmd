#!/usr/bin/env node
/**
 * done-means check for the MCP 2026-07-28 cutover (rodaddy/development#109).
 *
 * Makes a ONE-SHOT tools/call against a running qmd MCP HTTP server with the
 * 2026-07-28 headers and NO handshake: no `initialize`, no `Mcp-Session-Id`.
 * Under the 2025-06-18 sessionful transport this is rejected outright, which
 * is what makes it a RED check before the migration lands.
 *
 * Usage:
 *   node scripts/check-mcp-2026-07-28.mjs [--port 7142] [--tool status]
 *
 * The server must already be listening. Start it with:
 *   npx tsx src/cli/qmd.ts mcp --http --port 7142
 *
 * Exit 0 = the 2026-07-28 wire is served. Non-zero = it is not.
 */

const PROTOCOL_VERSION = "2026-07-28";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", process.env.QMD_MCP_PORT || "7142"));
const host = arg("host", "127.0.0.1");
const toolName = arg("tool", "status");
const url = `http://${host}:${port}/mcp`;

let failures = 0;
const note = (s) => console.log(s);
const pass = (s) => console.log(`  PASS  ${s}`);
const fail = (s) => {
  failures++;
  console.log(`  FAIL  ${s}`);
};

/**
 * Per spec §8, Mcp-Method is required on all Streamable HTTP POSTs and Mcp-Name
 * on tools/call, and MCP-Protocol-Version MUST match the body `_meta` value.
 */
function modernRequest(id, method, params = {}) {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "qmd-cutover-check",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": method,
  };
  const name = params.name ?? params.uri;
  if (name) headers["Mcp-Name"] = name;
  return { headers, body };
}

async function post(id, method, params) {
  const { headers, body } = modernRequest(id, method, params);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // SSE or non-JSON body — surface the raw text in the failure output.
  }
  return { res, text, json };
}

async function main() {
  note(`qmd MCP 2026-07-28 conformance check -> ${url}`);
  note(`protocol: ${PROTOCOL_VERSION}  tool: ${toolName}`);
  note("");

  // ---- 1. one-shot tools/call, no handshake -------------------------------
  note("1. one-shot tools/call with no initialize and no Mcp-Session-Id");
  let call;
  try {
    call = await post(1, "tools/call", { name: toolName, arguments: {} });
  } catch (err) {
    fail(`transport error: ${err.message}`);
    note("");
    note(`RESULT: ${failures} failure(s)`);
    process.exit(1);
  }

  note(`  HTTP ${call.res.status}`);
  note(`  body: ${call.text.slice(0, 400)}`);

  if (call.res.status !== 200) {
    fail(`expected HTTP 200, got ${call.res.status}`);
  } else {
    pass("HTTP 200");
  }

  if (call.json?.error) {
    fail(
      `expected a result, got JSON-RPC error ${call.json.error.code}: ${call.json.error.message}`,
    );
  } else if (call.json?.result) {
    pass("JSON-RPC result present");
    if (call.json.result.resultType === "complete") {
      pass('resultType is "complete"');
    } else {
      fail(
        `resultType must be "complete" or "input_required", got ${JSON.stringify(call.json.result.resultType)}`,
      );
    }
  } else {
    fail("response carried neither result nor error");
  }

  // The 2026-07-28 revision is per-request: the server MUST NOT mint a session.
  const mintedSession = call.res.headers.get("mcp-session-id");
  if (mintedSession) {
    fail(`server minted Mcp-Session-Id on a modern request: ${mintedSession}`);
  } else {
    pass("no Mcp-Session-Id minted (stateless per-request)");
  }

  // ---- 2. header/body mismatch -> 400 + -32020 ----------------------------
  note("");
  note("2. Mcp-Name header not matching the body -> 400 + -32020");
  try {
    const { headers, body } = modernRequest(2, "tools/call", {
      name: toolName,
      arguments: {},
    });
    headers["Mcp-Name"] = "not_the_body_value";
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* surfaced below */
    }
    note(`  HTTP ${res.status}  body: ${text.slice(0, 300)}`);
    if (res.status === 400) pass("HTTP 400");
    else fail(`expected HTTP 400, got ${res.status}`);
    if (json?.error?.code === -32020) pass("JSON-RPC -32020 HeaderMismatch");
    else fail(`expected error code -32020, got ${JSON.stringify(json?.error?.code)}`);
  } catch (err) {
    fail(`transport error: ${err.message}`);
  }

  // ---- 3. tools/list carries strict schemas -------------------------------
  note("");
  note("3. tools/list over the modern wire, strict inputSchema (our standard)");
  try {
    const list = await post(3, "tools/list", {});
    note(`  HTTP ${list.res.status}`);
    const tools = list.json?.result?.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      pass(`tools/list returned ${tools.length} tool(s)`);
      const loose = tools.filter(
        (t) => t.inputSchema?.additionalProperties !== false,
      );
      if (loose.length === 0) {
        pass("every inputSchema sets additionalProperties:false");
      } else {
        fail(
          `tools without additionalProperties:false -> ${loose.map((t) => t.name).join(", ")}`,
        );
      }
    } else {
      fail(`tools/list returned no tools: ${list.text.slice(0, 300)}`);
    }
  } catch (err) {
    fail(`transport error: ${err.message}`);
  }

  // ---- 4. GET /mcp -> 405 -------------------------------------------------
  note("");
  note("4. GET /mcp -> 405 (modern servers have no standalone stream)");
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "MCP-Protocol-Version": PROTOCOL_VERSION },
    });
    note(`  HTTP ${res.status}`);
    if (res.status === 405) pass("HTTP 405");
    else fail(`expected HTTP 405, got ${res.status}`);
  } catch (err) {
    fail(`transport error: ${err.message}`);
  }

  // ---- 5. unknown tool -> protocol error, not isError ---------------------
  note("");
  note("5. unknown tool -> JSON-RPC -32602 (protocol channel)");
  try {
    const unknown = await post(5, "tools/call", {
      name: "definitely_not_a_qmd_tool",
      arguments: {},
    });
    note(`  HTTP ${unknown.res.status}  body: ${unknown.text.slice(0, 300)}`);
    if (unknown.json?.error?.code === -32602) {
      pass("JSON-RPC -32602 for unknown tool");
    } else {
      fail(
        `expected -32602, got ${JSON.stringify(unknown.json?.error?.code ?? unknown.json?.result)}`,
      );
    }
  } catch (err) {
    fail(`transport error: ${err.message}`);
  }

  note("");
  if (failures === 0) {
    note("RESULT: PASS — qmd serves the 2026-07-28 wire per request.");
    process.exit(0);
  }
  note(`RESULT: FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("check crashed:", err);
  process.exit(1);
});
