/**
 * retry.ts - bounded retry with exponential backoff for remote calls.
 *
 * A remote inference server fails in two distinguishable ways, and treating
 * them alike is a bug either direction:
 *
 *   TRANSIENT - a dropped connection, a timeout, a 503 while the server loads
 *   a model on demand, a 429 under load. The same request a moment later
 *   succeeds. Not retrying these turns a blip into a failed re-index of
 *   thousands of documents.
 *
 *   PERMANENT - a 404 for a model the server does not serve, a 400 for a
 *   malformed body. The same request will fail identically forever. Retrying
 *   these delays a certain error and multiplies load while doing it.
 *
 * So the classifier, not the retry count, is the load-bearing part.
 */

import { errorFields, logger } from "./logging.js";

/** An HTTP failure whose status code survived, so it can be classified. */
export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/** A request that never got a response: DNS, refused, reset, timed out. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/**
 * Whether an error is worth trying again.
 *
 * Deliberately conservative: anything not recognised as transient is treated
 * as permanent. A wrong guess toward "retry" hammers a server with requests
 * that cannot succeed; a wrong guess toward "fail" surfaces a real error one
 * attempt sooner.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof TransportError) return true;
  if (err instanceof HttpStatusError) {
    // 408 request timeout, 429 too many requests, 5xx server-side.
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return false;
}

export type RetryOptions = {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Delay before the first retry, doubling each time. Default 250ms. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff wait. Default 5000ms. */
  maxDelayMs?: number;
  /** Operation name for log lines. */
  operation: string;
  /** Extra fields to attach to every log line for this operation. */
  context?: Record<string, string | number>;
};

/** Sleep, as a promise. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`, retrying transient failures with exponential backoff.
 *
 * Emits the five points the observability standard requires: entry (debug),
 * exit with duration (info), each retry (warn), and final failure (error).
 * Call sites get all of it by wrapping, rather than by remembering five calls.
 *
 * @param fn The operation to run. Called once per attempt.
 * @param options Attempt budget, backoff shape, and log context.
 * @returns Whatever `fn` resolves to.
 * @throws The last error, when every attempt failed or the error was
 *   permanent. Never swallowed and never replaced with a fallback value.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  const base = { operation: options.operation, ...options.context };

  logger.debug({ ...base, attempts }, "operation_start");
  const startedAt = Date.now();
  const inFlightToken = token(options.operation, startedAt);
  inFlight.add(inFlightToken);
  let lastError: unknown;
  let attempt = 0;
  let outcome: "ok" | "failed" = "failed";

  try {
    for (attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await fn();
        outcome = "ok";
        logger.info(
          { ...base, attempt, duration_ms: Date.now() - startedAt },
          "operation_ok",
        );
        return result;
      } catch (err) {
        lastError = err;
        // A permanent failure is not worth a second attempt: surface it now
        // rather than spending the budget proving it again.
        if (!isTransient(err) || attempt === attempts) break;

        const wait = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        logger.warn(
          {
            ...base,
            attempt,
            attempts,
            retry_in_ms: wait,
            ...errorFields(err),
          },
          "operation_retry",
        );
        await delay(wait);
      }
    }

    logger.error(
      {
        ...base,
        attempts_used: Math.min(attempt, attempts),
        duration_ms: Date.now() - startedAt,
        permanent: !isTransient(lastError),
        ...errorFields(lastError),
      },
      "operation_failed",
    );
    throw lastError;
  } finally {
    // Always runs, success or failure, so a caller watching this counter can
    // never be left believing an operation is still in flight.
    inFlight.delete(inFlightToken);
    logger.trace(
      { ...base, outcome, duration_ms: Date.now() - startedAt },
      "operation_settled",
    );
  }
}

/** In-flight operation tokens, for diagnostics and shutdown checks. */
const inFlight = new Set<string>();

function token(operation: string, startedAt: number): string {
  return `${operation}:${startedAt}`;
}

/** How many operations are currently in flight. */
export function inFlightCount(): number {
  return inFlight.size;
}
