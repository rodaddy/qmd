/**
 * logging.ts - structured logging for qmd's remote backends.
 *
 * qmd itself logs with `console.*` to stdout, which is correct for a CLI whose
 * stdout IS its output. This module is for the remote-inference paths, where
 * failures are operational rather than user-facing: a timeout, a 503 mid
 * re-index, a model the server does not know. Those need a timestamp, a
 * correlation id and a duration, not a sentence on a terminal.
 *
 * Two rules make this safe to add to a CLI:
 *
 *   1. Everything goes to STDERR. qmd has machine-readable output modes and a
 *      log line on stdout corrupts them.
 *   2. Silent by default. A CLI that starts emitting JSON at users is worse
 *      than one that says nothing, so the level defaults to `silent` and is
 *      raised by QMD_LOG_LEVEL.
 *
 * Standards: _DOCS/STANDARDS-typescript.md `## Logging and observability`.
 * Pino only, one preconfigured export, child loggers for per-operation
 * context, correlation ids carried across awaits by AsyncLocalStorage, and
 * never a raw error object spread into an entry.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pino, { type Logger } from "pino";

const VALID_LEVELS = new Set([
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

/**
 * Resolve the configured log level, failing loudly on an invalid one.
 *
 * An unreadable level silently defaulting to something quiet is how logging
 * gets turned off by a typo and nobody notices until an incident.
 *
 * @throws If QMD_LOG_LEVEL is set to a value pino does not accept.
 */
function resolveLevel(): string {
  const configured = process.env.QMD_LOG_LEVEL?.trim().toLowerCase();
  if (!configured) return "silent";
  if (!VALID_LEVELS.has(configured)) {
    throw new Error(
      `Invalid QMD_LOG_LEVEL: ${JSON.stringify(configured)}. ` +
        `Expected one of: ${[...VALID_LEVELS].join(", ")}`,
    );
  }
  return configured;
}

/** Per-operation context, carried across await boundaries. */
type LogContext = { correlation_id: string };

const contextStore = new AsyncLocalStorage<LogContext>();

/**
 * The service logger. One preconfigured export; call sites never assemble one.
 *
 * Writes to fd 2 (stderr) so stdout stays clean for qmd's own output.
 */
export const logger: Logger = pino(
  {
    level: resolveLevel(),
    base: { service: "qmd" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Attach the ambient correlation id to every line without asking call
      // sites to thread it -- one that must be passed by hand gets dropped.
      log: (entry) => {
        const ctx = contextStore.getStore();
        return ctx ? { correlation_id: ctx.correlation_id, ...entry } : entry;
      },
    },
    // Values that must never reach a log line even by accident.
    redact: {
      paths: [
        "*.authorization",
        "*.password",
        "*.token",
        "*.api_key",
        "*.apiKey",
        "*.secret",
        "*.cookie",
        "*.credential",
        "headers.authorization",
        "headers.cookie",
      ],
      censor: "[redacted]",
    },
  },
  pino.destination(2),
);

/**
 * Run `fn` under a fresh correlation id, so every line it emits is tied
 * together without the id being threaded through each call.
 */
export function withCorrelationId<T>(fn: () => T): T {
  return contextStore.run({ correlation_id: randomUUID() }, fn);
}

/** The active correlation id, when one is bound. */
export function currentCorrelationId(): string | undefined {
  return contextStore.getStore()?.correlation_id;
}

/**
 * Reduce an unknown thrown value to fields that are safe to log.
 *
 * Never spread a raw error: it can carry a `request`, `response`, `config` or
 * `cause` holding headers, bodies and credentials. Only an allowlisted
 * type/message/code summary comes out, with the message length-bounded.
 */
export function errorFields(err: unknown): {
  err_type: string;
  err_message: string;
  err_code?: string;
} {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      err_type: err.name,
      err_message: err.message.slice(0, 200),
      ...(typeof code === "string" ? { err_code: code } : {}),
    };
  }
  return { err_type: typeof err, err_message: String(err).slice(0, 200) };
}
