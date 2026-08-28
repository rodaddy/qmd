/**
 * pg-bridge-timeout.test.ts — the bridge must not be callable after a timeout.
 *
 * A timed-out syncQuery leaves its request in flight: worker.terminate() is
 * async, so the reply can still land on the port after the call throws. If the
 * database stayed callable, the next query would read that stale reply as its
 * own result — silent cross-request corruption. These tests drive PgDatabase
 * against a worker that never replies and assert the bridge poisons itself.
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

// Stub node:worker_threads before importing pg.ts so no real worker (and no
// real postgres) is ever spawned. The fake worker simply never notifies the
// shared Int32Array, which is exactly the "no response" condition.
// Bun's vitest shim cannot stub node:worker_threads for the bridge: mock.module
// is process-wide, so a silent worker here would hang every other Bun test
// that spawns one, and the tests themselves hang on the real Atomics.wait
// (qmd#8). Under Bun no mock is registered and the describe is skipped; the
// Vitest leg covers the invariant.
const underBun = typeof Bun !== "undefined";
const terminateCalls: number[] = [];
const portCloseCalls: number[] = [];

// Not hoisted on purpose: pg.js is imported dynamically inside each test, so
// the mock still applies under Vitest, and under Bun nothing is registered.
// Called through an alias so Vitest's hoisting transform leaves the `if` alone.
const mockModule = vi.mock;
if (!underBun)
  mockModule("node:worker_threads", async () => {
    const actual = await vi.importActual<typeof import("node:worker_threads")>(
      "node:worker_threads",
    );

    class SilentWorker {
      constructor(_path: string, _opts: unknown) {}
      terminate(): Promise<number> {
        terminateCalls.push(Date.now());
        return Promise.resolve(0);
      }
      unref(): void {}
      on(): void {}
    }

    class FakeMessageChannel {
      port1: unknown;
      port2: unknown;
      constructor() {
        this.port1 = {
          postMessage: () => {},
          close: () => {
            portCloseCalls.push(Date.now());
          },
          on: () => {},
          unref: () => {},
        };
        this.port2 = {};
      }
    }

    return {
      ...actual,
      Worker: SilentWorker,
      MessageChannel: FakeMessageChannel,
      // The port never carries a message; syncQuery must never get this far
      // on the timeout path anyway.
      receiveMessageOnPort: () => undefined,
    };
  });

const TIMEOUT_MS = "200";

let previousTimeout: string | undefined;

beforeEach(() => {
  previousTimeout = process.env.QMD_PG_QUERY_TIMEOUT_MS;
  process.env.QMD_PG_QUERY_TIMEOUT_MS = TIMEOUT_MS;
  terminateCalls.length = 0;
  portCloseCalls.length = 0;
});

afterEach(() => {
  if (previousTimeout === undefined) {
    delete process.env.QMD_PG_QUERY_TIMEOUT_MS;
  } else {
    process.env.QMD_PG_QUERY_TIMEOUT_MS = previousTimeout;
  }
});

describe.skipIf(underBun)("PgDatabase timeout poisoning", () => {
  test("a second query after a timeout throws immediately as unusable", async () => {
    const { PgDatabase } = await import("../src/pg.js");
    const db = new PgDatabase("postgresql://unused/never-connects");

    expect(() => db.syncQuery("all", "SELECT 1", [])).toThrow(
      /no response from postgres worker within 200ms/,
    );

    // The port is closed and the worker terminated on the timeout branch, so
    // no later reply can be misread as a subsequent query's result.
    expect(portCloseCalls.length).toBe(1);
    expect(terminateCalls.length).toBe(1);

    // The second call must fail fast on the poison flag, without waiting out
    // another timeout and without touching the (now closed) port.
    const startedAt = Date.now();
    expect(() => db.syncQuery("all", "SELECT 2", [])).toThrow(
      /bridge unusable after timeout/,
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(Number(TIMEOUT_MS));

    // Still exactly one close/terminate: the poisoned path does no further work.
    expect(portCloseCalls.length).toBe(1);
    expect(terminateCalls.length).toBe(1);
  });

  test("prepared statements on a poisoned bridge also throw unusable", async () => {
    const { PgDatabase } = await import("../src/pg.js");
    const db = new PgDatabase("postgresql://unused/never-connects");

    expect(() => db.exec("SELECT 1")).toThrow(/no response from postgres/);
    expect(() => db.prepare("SELECT ?").all(1)).toThrow(
      /bridge unusable after timeout/,
    );
  });
});
