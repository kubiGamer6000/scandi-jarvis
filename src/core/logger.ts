import { env } from "./env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const threshold = LEVELS[env.LOG_LEVEL];

function format(level: LogLevel, scope: string, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const tag = `[${ts}] ${level.toUpperCase().padEnd(5)} ${scope}`;
  if (meta !== undefined) {
    return `${tag} ${msg} ${JSON.stringify(meta)}`;
  }
  return `${tag} ${msg}`;
}

/**
 * Tiny, dependency-free structured logger. Each call site creates a child via
 * `createLogger("scope")` so the scope is prepended to every line. We can swap
 * this for pino/winston later without touching call sites.
 */
export function createLogger(scope: string) {
  return {
    debug(msg: string, meta?: unknown) {
      if (LEVELS.debug >= threshold) {
        console.debug(format("debug", scope, msg, meta));
      }
    },
    info(msg: string, meta?: unknown) {
      if (LEVELS.info >= threshold) {
        console.log(format("info", scope, msg, meta));
      }
    },
    warn(msg: string, meta?: unknown) {
      if (LEVELS.warn >= threshold) {
        console.warn(format("warn", scope, msg, meta));
      }
    },
    error(msg: string, meta?: unknown) {
      if (LEVELS.error >= threshold) {
        console.error(format("error", scope, msg, meta));
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
