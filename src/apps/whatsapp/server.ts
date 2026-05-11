import Fastify, { type FastifyInstance } from "fastify";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { env, hasCredential } from "../../core/env.js";
import { closePool, getPool, isDbConfigured } from "../../core/db.js";
import { createLogger } from "../../core/logger.js";
import { closeSandbox } from "../../core/sandbox.js";

import { buildWhatsappAgent } from "./agent.js";
import { createWhatsappClient } from "./client.js";
import { Dispatcher } from "./dispatcher.js";
import { purgeExpired } from "./idempotency.js";
import { registerWebhookRoute } from "./webhook.js";
import { allowedChatCount } from "./whitelist.js";

const log = createLogger("apps/whatsapp/server");

const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "WA_BOT_BASE_URL",
  "WA_BOT_TOKEN",
  "WA_WEBHOOK_SECRET",
  "SUPABASE_DB_URL",
] as const;

async function preflightChecks(): Promise<void> {
  const missing = REQUIRED_ENV.filter((k) => !hasCredential(k));
  if (missing.length > 0) {
    log.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (allowedChatCount() === 0) {
    log.error(
      "JARVIS_WA_ALLOWED_CHATS is empty — Jarvis would drop every message. " +
        "Set this to '*' (fully open) or a comma-separated JID list.",
    );
    process.exit(1);
  }
  if (!isDbConfigured()) {
    log.error("SUPABASE_DB_URL is not configured (impossible given preflight, but just in case).");
    process.exit(1);
  }

  log.info("preflight: env OK", {
    allowed_chats: allowedChatCount(),
  });

  // Probe DB.
  try {
    const pool = getPool()!;
    const res = await pool.query<{ now: string }>("select now() as now");
    log.info("preflight: postgres OK", { now: res.rows[0]?.now });
  } catch (err) {
    log.error("preflight: postgres failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Probe WA bot.
  try {
    const probe = createWhatsappClient();
    const h = await probe.health();
    if (!h.sock_connected) {
      log.warn("preflight: WA bot is up but socket is NOT connected — messages will queue", h);
    } else {
      log.info("preflight: WA bot OK", h);
    }
  } catch (err) {
    log.error("preflight: WA bot health failed — check WA_BOT_BASE_URL/WA_BOT_TOKEN", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

async function buildServer(): Promise<{
  app: FastifyInstance;
  dispatcher: Dispatcher;
}> {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });

  // Capture raw body for HMAC verification. We replace Fastify's JSON
  // parser with one that keeps the original buffer attached to `request.rawBody`.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        const json = JSON.parse(body.toString("utf8"));
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const client = createWhatsappClient();
  const me = await client.me();
  log.info("WA identity", me);

  const checkpointer = PostgresSaver.fromConnString(env.SUPABASE_DB_URL!);
  await checkpointer.setup();
  log.info("langgraph checkpoints: setup OK");

  const agent = await buildWhatsappAgent({ client, checkpointer });

  const dispatcher = new Dispatcher({
    agent,
    client,
    self: { pnJid: me.pn_jid, lidJid: me.lid_jid, accountId: me.account_id },
  });

  registerWebhookRoute(app, { dispatcher });

  app.get("/health", async () => {
    let waHealthy = false;
    try {
      const h = await client.health();
      waHealthy = h.sock_connected;
    } catch {
      // ignore
    }
    return {
      ok: true,
      wa_bot_connected: waHealthy,
      allowed_chats: allowedChatCount(),
      uptime_s: Math.floor(process.uptime()),
    };
  });

  // Hourly background sweep of the dedup table.
  const purgeTimer = setInterval(
    () => {
      void purgeExpired();
    },
    60 * 60 * 1000,
  );
  // Prevent the timer from holding the event loop open during shutdown.
  purgeTimer.unref();

  return { app, dispatcher };
}

async function main(): Promise<void> {
  log.info("starting WhatsApp app", {
    port: env.JARVIS_WA_PORT,
    host: env.JARVIS_WA_HOST,
  });

  await preflightChecks();

  const { app, dispatcher } = await buildServer();
  await app.listen({ host: env.JARVIS_WA_HOST, port: env.JARVIS_WA_PORT });
  log.info(`listening on http://${env.JARVIS_WA_HOST}:${env.JARVIS_WA_PORT}`);

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`Received ${signal} — shutting down`);
    let exiting = false;
    (async () => {
      if (exiting) return;
      exiting = true;
      try {
        dispatcher.abortAll();
        await Promise.race([
          dispatcher.drain(),
          new Promise((res) => setTimeout(res, 5_000)),
        ]);
        await app.close();
        await closePool();
        await closeSandbox();
      } catch (err) {
        log.warn("shutdown error", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        process.exit(0);
      }
    })().catch(() => process.exit(1));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  await closePool().catch(() => undefined);
  await closeSandbox().catch(() => undefined);
  process.exit(1);
});
