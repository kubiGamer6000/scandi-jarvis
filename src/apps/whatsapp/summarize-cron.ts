/**
 * Stand-alone cron worker that proactively refreshes daily summaries for
 * chats with recent activity so the user-facing runner rarely pays the
 * synchronous summary cost.
 *
 * Usage:
 *   npm run wa:summarize-cron            # one-shot pass and exit (cron-friendly)
 *   LOOP=1 npm run wa:summarize-cron     # long-running mode: pass every hour
 *
 * Deployment options:
 *   - cron + the one-shot mode, every hour
 *   - systemd timer (recommended), every hour with `OnUnitActiveSec=1h`
 *   - pm2 / supervisord with `LOOP=1`
 *   - Vercel cron pointing at a stub HTTP endpoint that triggers this
 */
import { closePool, getPool } from "../../core/db.js";
import { hasCredential } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import { createWhatsappClient } from "./client.js";
import {
  refreshDailyIfStale,
  refreshWeeklyIfStale,
} from "./summaries.js";
import { isChatAllowed } from "./whitelist.js";

const log = createLogger("apps/whatsapp/summarize-cron");

const REQUIRED_ENV = [
  "WA_BOT_BASE_URL",
  "WA_BOT_TOKEN",
  "SUPABASE_DB_URL",
  "ANTHROPIC_API_KEY",
] as const;

/**
 * Find chats with recent activity: rows in `jarvis.chat_context`, OR chats
 * that have produced messages within the last 7 days (we read the WA bot's
 * wa.chats / wa.messages tables to discover activity even for chats that
 * haven't been touched by Jarvis yet).
 *
 * For now we just walk every row in `jarvis.chat_context` (every chat we've
 * ever responded in) — that's the set that matters for context. Brand-new
 * chats get their summary built lazily by the runner on first contact.
 */
async function activeChats(): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  const res = await pool.query<{ chat_jid: string }>(
    `select chat_jid
       from jarvis.chat_context
      where enabled = true`,
  );
  return res.rows.map((r) => r.chat_jid).filter(isChatAllowed);
}

async function onePass(): Promise<void> {
  const t0 = Date.now();
  const client = createWhatsappClient();
  const chats = await activeChats();
  log.info("starting pass", { chats: chats.length });

  let updated = 0;
  let failed = 0;
  for (const chatJid of chats) {
    try {
      const daily = await refreshDailyIfStale({ client, chatJid });
      const weekly = await refreshWeeklyIfStale({ client, chatJid });
      if (daily.changed || weekly.changed) updated += 1;
      log.debug("chat done", {
        chat_jid: chatJid,
        daily_reason: daily.reason,
        weekly_reason: weekly.reason,
      });
    } catch (err) {
      failed += 1;
      log.warn("chat refresh failed", {
        chat_jid: chatJid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("pass complete", {
    chats: chats.length,
    updated,
    failed,
    duration_ms: Date.now() - t0,
  });
}

async function main(): Promise<void> {
  const missing = REQUIRED_ENV.filter((k) => !hasCredential(k));
  if (missing.length > 0) {
    log.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  if (process.env.LOOP === "1") {
    log.info("entering loop mode (one pass every hour)");
    let running = true;
    process.once("SIGINT", () => {
      log.info("SIGINT received, exiting after current pass");
      running = false;
    });
    process.once("SIGTERM", () => {
      log.info("SIGTERM received, exiting after current pass");
      running = false;
    });
    while (running) {
      try {
        await onePass();
      } catch (err) {
        log.error("pass failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Sleep an hour (interruptible).
      const sleepMs = 60 * 60 * 1000;
      const t0 = Date.now();
      while (running && Date.now() - t0 < sleepMs) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  } else {
    await onePass();
  }
  await closePool();
}

main().catch(async (err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  await closePool().catch(() => undefined);
  process.exit(1);
});
