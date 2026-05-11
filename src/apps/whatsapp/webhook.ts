import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type { Dispatcher } from "./dispatcher.js";
import { markSeen } from "./idempotency.js";
import type { WebhookEnvelope } from "./types.js";

const log = createLogger("apps/whatsapp/webhook");

const MAX_TIMESTAMP_SKEW_S = 300; // 5 minutes — matches the bot's example.

export interface RegisterWebhookOptions {
  dispatcher: Dispatcher;
  path?: string;
}

export function registerWebhookRoute(
  app: FastifyInstance,
  opts: RegisterWebhookOptions,
): void {
  const path = opts.path ?? "/wa-webhook";

  app.post(
    path,
    {
      // Raw body is required for HMAC verification. We register a content-type
      // parser at server boot that exposes `request.rawBody` as a Buffer.
      config: { rawBody: true },
    },
    async (request, reply) => {
      const rawBody: Buffer | undefined = (request as FastifyRequest & {
        rawBody?: Buffer;
      }).rawBody;
      if (!rawBody) {
        log.warn("missing raw body");
        return reply.code(400).send({ error: "missing raw body" });
      }

      const ts = headerString(request, "x-webhook-timestamp");
      const sig = headerString(request, "x-webhook-signature");
      const id = headerString(request, "x-webhook-id");
      const event = headerString(request, "x-webhook-event");

      if (!ts || !sig) {
        return reply
          .code(401)
          .send({ error: "missing signature/timestamp headers" });
      }

      if (!env.WA_WEBHOOK_SECRET) {
        log.error("WA_WEBHOOK_SECRET not set — refusing webhook");
        return reply.code(500).send({ error: "server misconfigured" });
      }

      // Replay-protection: drop very-old payloads.
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(ts)) > MAX_TIMESTAMP_SKEW_S) {
        log.warn("timestamp out of window", { ts, now });
        return reply.code(401).send({ error: "stale timestamp" });
      }

      if (!verifySignature(env.WA_WEBHOOK_SECRET, ts, rawBody, sig)) {
        log.warn("bad signature", { id, event });
        return reply.code(401).send({ error: "bad signature" });
      }

      // Idempotency check.
      if (id) {
        const seen = await markSeen(id);
        if (seen) {
          return reply.code(200).send({ ok: true, dedup: true });
        }
      } else {
        log.warn("delivery missing X-Webhook-Id; dedup not applied");
      }

      let payload: WebhookEnvelope;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as WebhookEnvelope;
      } catch (err) {
        log.warn("invalid JSON body", {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(400).send({ error: "invalid json" });
      }

      // Only act on inbound message events. message.processed / .reacted /
      // .edited / .deleted are useful signals but for v1 the runner builds
      // its own context fresh, so we don't need to act on them. (We will
      // consume `message.processed` later in phase 2 media-wait.)
      if (payload.event !== "message.received") {
        log.debug("ignoring non-received event", { event: payload.event });
        return reply.code(200).send({ ok: true, ignored: payload.event });
      }

      const message = payload.message;
      if (!message) {
        return reply.code(200).send({ ok: true, ignored: "empty message" });
      }

      // Respond fast — heavy lifting happens off the request thread.
      void reply.code(200).send({ ok: true });
      try {
        opts.dispatcher.ingest({ message });
      } catch (err) {
        log.error("dispatcher.ingest threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function verifySignature(
  secret: string,
  ts: string,
  rawBody: Buffer,
  signatureHeader: string,
): boolean {
  const expectedMac = createHmac("sha256", secret)
    .update(`${ts}.`)
    .update(rawBody)
    .digest("hex");
  const expected = `sha256=${expectedMac}`;
  // timingSafeEqual requires same-length buffers.
  if (expected.length !== signatureHeader.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
