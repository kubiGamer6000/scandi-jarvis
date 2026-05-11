import pg from "pg";

import { env, hasCredential } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("core/db");

/**
 * Process-wide singleton `pg.Pool` against `SUPABASE_DB_URL`.
 *
 * Shared by:
 *   - jarvis.chat_context              (summaries + AGENTS.md-style notes)
 *   - jarvis.wa_webhook_seen           (webhook idempotency)
 *   - @langchain/langgraph-checkpoint-postgres
 *     (the checkpointer constructs its own client from this same URL via
 *     PostgresSaver.fromConnString – it does NOT share this pool, by design,
 *     to keep its connection lifecycle independent.)
 *
 * Returns `null` (and does NOT throw) when `SUPABASE_DB_URL` is unset – the
 * CLI agent doesn't need a DB to operate. Modules that need the pool should
 * call `requirePool()` instead and fail fast.
 */
let pool: pg.Pool | null = null;
let cleanupRegistered = false;

export function isDbConfigured(): boolean {
  return hasCredential("SUPABASE_DB_URL");
}

export function getPool(): pg.Pool | null {
  if (!isDbConfigured()) return null;
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: env.SUPABASE_DB_URL,
    // Reasonable defaults for a serverless-ish workload (lots of short-lived
    // connections via Supabase's transaction pooler). Tune if needed.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    log.error("idle pg client error", { error: err.message });
  });

  registerCleanup();
  log.info("postgres pool initialised");
  return pool;
}

export function requirePool(): pg.Pool {
  const p = getPool();
  if (!p) {
    throw new Error(
      "SUPABASE_DB_URL is not configured – this module requires Postgres. " +
        "Set it in .env to enable the WhatsApp app and persistent checkpointer.",
    );
  }
  return p;
}

/**
 * Best-effort `pool.end()`. Safe to call multiple times.
 */
export async function closePool(): Promise<void> {
  const pending = pool;
  pool = null;
  if (!pending) return;
  try {
    await pending.end();
    log.info("postgres pool closed");
  } catch (err) {
    log.warn("pool.end() failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("beforeExit", () => {
    void closePool();
  });
}
