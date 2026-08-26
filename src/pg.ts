/**
 * pg.ts — PostgreSQL adapter implementing the Database/Statement interfaces.
 *
 * Uses a Worker thread to run async postgres queries and Atomics.wait() to
 * block the caller, exposing a synchronous API compatible with SQLite adapters.
 *
 * SQL differences handled here:
 *   - ? placeholders -> $1, $2, ...
 *   - Float32Array params -> pgvector literal '[f1,f2,...]'
 *   - loadExtension() is a no-op
 */

import {
  MessageChannel,
  receiveMessageOnPort,
  type MessagePort,
  Worker,
} from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { Database, SQLiteValue, Statement } from "./db.js";

type QueryType = "exec" | "run" | "get" | "all" | "close";

type WorkerResponse = {
  result: unknown;
  error: string | null;
  seq?: number;
};

/**
 * Translate SQLite-style `?` placeholders to PostgreSQL `$N` placeholders.
 * Skips placeholders inside SQL string literals.
 */
function translatePlaceholders(sql: string): string {
  let i = 0;
  let index = 0;
  let out = "";

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        const sch = sql[i]!;
        out += sch;
        if (sch === "'") {
          if (sql[i + 1] === "'") {
            out += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    if (ch === "?") {
      index += 1;
      out += `$${index}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Convert Float32Array params to pgvector text literal.
 */
function convertParams(params: unknown[]): unknown[] {
  return params.map((param) => {
    if (param instanceof Float32Array) {
      return `[${Array.from(param).join(",")}]`;
    }
    return param;
  });
}

const DEFAULT_QUERY_TIMEOUT_MS = 600_000;

/**
 * Deadline for a single synchronous bridge query, in milliseconds.
 * Override with QMD_PG_QUERY_TIMEOUT_MS.
 */
function getQueryTimeoutMs(): number {
  const raw = process.env.QMD_PG_QUERY_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_QUERY_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_QUERY_TIMEOUT_MS;
}

function resolveWorkerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const workerFile = thisFile.endsWith(".ts") ? "pg-worker.ts" : "pg-worker.js";
  return fileURLToPath(new URL(`./${workerFile}`, import.meta.url));
}

class PgStatement implements Statement {
  constructor(
    private readonly db: PgDatabase,
    private readonly sql: string,
  ) {}

  run(...params: SQLiteValue[]): {
    changes: number;
    lastInsertRowid: number | bigint;
  } {
    return this.db.syncQuery("run", this.sql, params) as {
      changes: number;
      lastInsertRowid: number | bigint;
    };
  }

  get<T = unknown>(...params: SQLiteValue[]): T | undefined {
    return this.db.syncQuery("get", this.sql, params) as T | undefined;
  }

  all<T = unknown>(...params: SQLiteValue[]): T[] {
    return (this.db.syncQuery("all", this.sql, params) as T[]) ?? [];
  }

  iterate<T = unknown>(...params: SQLiteValue[]): IterableIterator<T> {
    // The Atomics bridge has no cursor protocol; materialise then iterate.
    return this.all<T>(...params)[Symbol.iterator]();
  }
}

export class PgDatabase implements Database {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly waitState: Int32Array;
  // A timed-out query is still in flight: the worker may deliver its reply to
  // the port afterwards, where the next syncQuery would read it as its own
  // result. Once that happens the bridge cannot be trusted again, so it is
  // poisoned permanently rather than left callable.
  private poisoned = false;
  private seq = 0;

  constructor(url: string) {
    const sharedBuffer = new SharedArrayBuffer(4);
    this.waitState = new Int32Array(sharedBuffer);

    const { port1, port2 } = new MessageChannel();
    this.port = port1;

    const workerPath = resolveWorkerPath();
    const isBunRuntime =
      typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
    const workerNeedsTsx = !isBunRuntime && workerPath.endsWith(".ts");

    this.worker = new Worker(workerPath, {
      workerData: {
        pgUrl: url,
        sharedBuffer,
        port: port2,
      },
      transferList: [port2],
      execArgv: workerNeedsTsx ? ["--import", "tsx/esm"] : [],
    });
  }

  syncQuery(type: QueryType, query: string, params: unknown[]): unknown {
    if (this.poisoned) {
      throw new Error("[PgDatabase] bridge unusable after timeout");
    }

    Atomics.store(this.waitState, 0, 0);

    const seq = ++this.seq;
    this.port.postMessage({
      type,
      query,
      params: convertParams(params),
      seq,
    });

    // A deadline, not a hang. Without one, a worker that dies before it can
    // notify (bad URL, crashed connection) leaves this thread blocked forever
    // and unable to receive the worker's own 'error'/'exit' events. The default
    // is deliberately generous: an HNSW build over hundreds of thousands of
    // rows is a legitimate long query.
    const timeoutMs = getQueryTimeoutMs();
    const waitResult = Atomics.wait(this.waitState, 0, 0, timeoutMs);
    if (waitResult === "timed-out") {
      // terminate() is async, so the in-flight message can still land on the
      // port after this throws. Close the port and poison the bridge so no
      // later query can pick up this query's stale reply.
      this.poisoned = true;
      this.port.close();
      void this.worker.terminate();
      throw new Error(
        `[PgDatabase] no response from postgres worker within ${timeoutMs}ms`,
      );
    }

    // Skip any reply left over from an earlier request; only the seq we are
    // awaiting is ours.
    for (;;) {
      const response = receiveMessageOnPort(this.port);
      if (!response?.message) {
        throw new Error("[PgDatabase] no response from postgres worker");
      }

      const payload = response.message as WorkerResponse;
      if (payload.seq !== seq) continue;

      if (payload.error) {
        throw new Error(payload.error);
      }

      return payload.result;
    }
  }

  exec(sql: string): void {
    this.syncQuery("exec", sql, []);
  }

  prepare(sql: string): Statement {
    return new PgStatement(this, translatePlaceholders(sql));
  }

  // PostgreSQL extensions are managed by CREATE EXTENSION.
  loadExtension(_path: string): void {}

  transaction<T extends (...args: SQLiteValue[]) => unknown>(fn: T): T {
    return ((...args: SQLiteValue[]): unknown => {
      this.exec("BEGIN");
      try {
        const result = fn(...args);
        this.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors; surface the original failure.
        }
        throw err;
      }
    }) as T;
  }

  close(): void {
    try {
      this.syncQuery("close", "", []);
    } catch {
      // Ignore close errors (worker may already be terminating).
    }
    // Both handles have to go, and terminate() alone does not do it. It is
    // async — the returned promise is deliberately discarded, so the thread is
    // still winding down when close() returns — and it says nothing about this
    // side's MessagePort. An open port is a live libuv handle, so leaving it
    // open keeps the event loop alive and the CLI never exits after its last
    // query. Closing the port and unref'ing the worker lets the process end on
    // its own once the work is done.
    this.port.close();
    this.worker.unref();
    void this.worker.terminate();
  }
}

export function openPgDatabase(url: string): Database {
  return new PgDatabase(url);
}
