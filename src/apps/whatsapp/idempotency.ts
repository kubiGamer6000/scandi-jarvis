import { requirePool } from "../../core/db.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("apps/whatsapp/idempotency");

/**
 * Webhook deliveries from scandi-wa-bot are at-least-once. We dedupe by
 * `X-Webhook-Id` (a string the bot ships on every attempt-group) backed by
 * `jarvis.wa_webhook_seen` with a 24h TTL.
 *
 * Pattern:
 *   const seen = await markSeen(id);
 *   if (seen) return 200;  // already processed
 *   ...do work...
 *
 * Returns `true` when the id was *already* seen (caller should skip), and
 * `false` when it's the first time (caller should process).
 *
 * Race-safe: we rely on the primary-key unique violation, so two concurrent
 * webhook deliveries with the same id will only have one successful insert
 * (the other gets a 23505 -> we treat that as "already seen").
 */
export async function markSeen(id: string): Promise<boolean> {
  if (!id) {
    // No id header → we can't dedupe. Treat as fresh; the caller logs.
    return false;
  }
  const pool = requirePool();
  try {
    const result = await pool.query(
      `insert into jarvis.wa_webhook_seen (id) values ($1)
       on conflict (id) do nothing
       returning id`,
      [id],
    );
    if (result.rowCount === 0) {
      log.debug("duplicate webhook", { id });
      return true;
    }
    return false;
  } catch (err) {
    // If the DB is briefly unhappy, lean toward "fresh" so we don't drop
    // events silently. The agent's own work is idempotent enough at the
    // chat level (the dispatcher dedups by chat state anyway).
    log.warn("markSeen failed; treating as fresh", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Garbage-collect expired entries. Called from a periodic interval at server
 * boot; cheap enough to run hourly. Safe to call from the same process as
 * the webhook handler — pg pool handles concurrency.
 */
export async function purgeExpired(): Promise<number> {
  const pool = requirePool();
  try {
    const result = await pool.query<{ count: number }>(
      "select jarvis.purge_expired_webhooks()::int as count",
    );
    const n = result.rows[0]?.count ?? 0;
    if (n > 0) log.info("purged expired webhook ids", { count: n });
    return n;
  } catch (err) {
    log.warn("purgeExpired failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
