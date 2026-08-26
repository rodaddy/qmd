/**
 * pg-worker.ts — Worker thread that manages a PostgreSQL connection pool.
 *
 * Runs inside a worker_threads Worker. The main thread sends query messages
 * and blocks on a SharedArrayBuffer using Atomics. This worker executes the
 * async postgres query, writes the result to the message port, then
 * signals the main thread via Atomics.notify().
 *
 * Protocol:
 *   Main → Worker: { type, query, params }
 *   Worker → Main: { result, error }
 *   Worker: Atomics.store(sharedInt32, 0, 1); Atomics.notify(sharedInt32, 0)
 */

import { workerData } from "node:worker_threads";
import postgres from "postgres";

const pgUrl: string = workerData.pgUrl;
const sharedBuffer: SharedArrayBuffer = workerData.sharedBuffer;
const port = workerData.port;

const sharedInt32 = new Int32Array(sharedBuffer);

// Single connection — one query at a time (matching synchronous caller semantics).
// Constructed LAZILY on first use: building it at module top level means a bad
// URL throws before the message handler is installed, killing the worker while
// the main thread is already blocked in Atomics.wait and therefore unable to
// receive the 'error'/'exit' events. Inside the handler the same failure is
// posted back as { error } like any other query error.
function createSql() {
  return postgres(pgUrl, {
    max: 1,
    idle_timeout: 60,
    connect_timeout: 10,
    // Opt-in durability trade for bulk embed writes: the commit returns before
    // the WAL is flushed, so a server crash can lose recent transactions. The
    // vector index is rebuildable from the documents, hence the knob — but it
    // stays off unless QMD_PG_SYNCHRONOUS_COMMIT is exactly "off". Sent as a
    // startup parameter so it is session-scoped and survives a reconnect,
    // rather than a SET that a new connection would silently drop.
    connection:
      process.env.QMD_PG_SYNCHRONOUS_COMMIT === "off"
        ? { synchronous_commit: "off" }
        : {},
    // Server NOTICEs (e.g. from CREATE EXTENSION IF NOT EXISTS) are printed as
    // raw objects on stdout by the default handler, corrupting CLI output.
    onnotice: () => {},
    // Parse int8 (bigint) as regular JS numbers to match SQLite behavior
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: bigint | number | string) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
}

let sql: ReturnType<typeof createSql> | null = null;

function getSql(): ReturnType<typeof createSql> {
  if (!sql) sql = createSql();
  return sql;
}

/**
 * Convert BigInt values in a row to Number to ensure postMessage
 * compatibility and match SQLite's numeric behavior.
 */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

function normalizeRows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map(normalizeRow);
}

type QueryMessage = {
  type: "exec" | "run" | "get" | "all" | "close";
  query: string;
  params: unknown[];
  // Echoed back in the reply so the blocked caller can tell its own response
  // apart from one left over by an earlier, timed-out request.
  seq?: number;
};

port.on("message", async (msg: QueryMessage) => {
  const { type, query, params, seq } = msg;
  let result: unknown = null;
  let error: string | null = null;

  try {
    if (type === "close") {
      if (sql) await sql.end({ timeout: 5 });
      result = null;
    } else if (type === "exec") {
      await getSql().unsafe(query, []);
      result = { changes: 0, lastInsertRowid: 0 };
    } else if (type === "run") {
      const rows = await getSql().unsafe(
        query,
        params as postgres.ParameterOrJSON<never>[],
      );
      result = {
        changes: (rows as unknown as { count: number }).count ?? 0,
        lastInsertRowid: 0,
      };
    } else if (type === "get") {
      const rows = await getSql().unsafe(
        query,
        params as postgres.ParameterOrJSON<never>[],
      );
      result =
        rows.length > 0
          ? normalizeRow(rows[0] as Record<string, unknown>)
          : null;
    } else if (type === "all") {
      const rows = await getSql().unsafe(
        query,
        params as postgres.ParameterOrJSON<never>[],
      );
      result = normalizeRows(rows as readonly Record<string, unknown>[]);
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
    // The error travels back in the payload; a worker must not write to stdio
    // while its parent thread is blocked in Atomics.wait. Debug only.
    if (type !== "close" && process.env.QMD_PG_DEBUG === "1") {
      console.error(
        "[pg-worker] query error:",
        error,
        "\nSQL:",
        query,
        "\nParams:",
        params,
      );
    }
  }

  // Post result before signalling so main thread can receiveMessageOnPort
  port.postMessage({ result, error, seq });

  // Signal main thread that result is ready
  Atomics.store(sharedInt32, 0, 1);
  Atomics.notify(sharedInt32, 0, 1);
});
