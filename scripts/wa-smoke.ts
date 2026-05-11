/**
 * End-to-end smoke for the WhatsApp frontend webhook.
 *
 *   npm run smoke:wa
 *
 * POSTs a signed `message.received` envelope at the local WA webhook server
 * and asserts that the bot saw an outbound send (via the bot's REST API) for
 * the same chat within N seconds.
 *
 * This is deployable as a healthcheck — point it at a live `wa:server` and
 * the WA bot, and it'll confirm the whole pipeline is alive.
 *
 * Required env (read at runtime, not import-time):
 *   WA_BOT_BASE_URL, WA_BOT_TOKEN, WA_WEBHOOK_SECRET, JARVIS_WA_ALLOWED_CHATS
 * Optional:
 *   JARVIS_WA_SMOKE_TARGET   default http://127.0.0.1:${JARVIS_WA_PORT||8088}/wa-webhook
 *   JARVIS_WA_SMOKE_CHAT_JID default = first entry in JARVIS_WA_ALLOWED_CHATS
 *   JARVIS_WA_SMOKE_FROM_JID default 35988443029300@s.whatsapp.net
 *   JARVIS_WA_SMOKE_TEXT     default "ping from wa-smoke"
 *   JARVIS_WA_SMOKE_TIMEOUT_MS default 90000
 *
 * Exits 0 on success, non-zero on any failure.
 */
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";

import "dotenv/config";

import type {
  FetchMessagesResponse,
  MessagePayload,
  WebhookEnvelope,
} from "../src/apps/whatsapp/types.js";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: ${name} is required for wa-smoke`);
    process.exit(2);
  }
  return v;
}

const botBaseUrl = envOrThrow("WA_BOT_BASE_URL").replace(/\/$/, "");
const botToken = envOrThrow("WA_BOT_TOKEN");
const webhookSecret = envOrThrow("WA_WEBHOOK_SECRET");

const allowedChats = (process.env["JARVIS_WA_ALLOWED_CHATS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const chatJid =
  process.env["JARVIS_WA_SMOKE_CHAT_JID"] ??
  allowedChats.find((c) => c !== "*") ??
  "";
if (!chatJid) {
  console.error(
    "FATAL: no smoke chat — set JARVIS_WA_SMOKE_CHAT_JID or " +
      "JARVIS_WA_ALLOWED_CHATS to a concrete JID",
  );
  process.exit(2);
}

const serverPort = process.env["JARVIS_WA_PORT"] ?? "8088";
const target =
  process.env["JARVIS_WA_SMOKE_TARGET"] ??
  `http://127.0.0.1:${serverPort}/wa-webhook`;

const fromJid =
  process.env["JARVIS_WA_SMOKE_FROM_JID"] ?? "35988443029300@s.whatsapp.net";
const text = process.env["JARVIS_WA_SMOKE_TEXT"] ?? "ping from wa-smoke";
const timeoutMs = Number(process.env["JARVIS_WA_SMOKE_TIMEOUT_MS"] ?? 90_000);

const isGroup = chatJid.endsWith("@g.us");

/* ---------- 1) take a "before" snapshot of the bot's outbound history ---------- */

async function botFetchMessages(): Promise<FetchMessagesResponse> {
  const url = new URL(
    `${botBaseUrl}/v1/chats/${encodeURIComponent(chatJid)}/messages`,
  );
  url.searchParams.set("limit", "20");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `bot fetchMessages → ${res.status} ${res.statusText}: ${await res.text()}`,
    );
  }
  return (await res.json()) as FetchMessagesResponse;
}

console.log(`→ target: ${target}`);
console.log(`→ chat:   ${chatJid}`);
console.log(`→ before-snapshot…`);

let beforeMaxSeq = 0;
try {
  const before = await botFetchMessages();
  for (const m of before.messages) {
    if (m.from_me && m.seq > beforeMaxSeq) beforeMaxSeq = m.seq;
  }
  console.log(`  before: last from_me seq = ${beforeMaxSeq || "(none)"}`);
} catch (err) {
  console.error(
    "FATAL: could not query the WA bot for the before-snapshot:",
    err instanceof Error ? err.message : err,
  );
  process.exit(3);
}

/* ---------- 2) build + sign a canned webhook ---------- */

const now = new Date();
const tsSec = Math.floor(now.getTime() / 1000);
const triggerSeq = Math.floor(Date.now() / 1000);

const envelope: WebhookEnvelope = {
  event: "message.received",
  created_at: now.toISOString(),
  account: { id: "smoke-account" },
  message: {
    seq: triggerSeq,
    wa_id: `SMOKE_${randomUUID()}`,
    chat: {
      jid: chatJid,
      type: isGroup ? "group" : "dm",
      subject: isGroup ? "wa-smoke group" : null,
      participant_count: isGroup ? 2 : null,
    },
    from: {
      jid: fromJid,
      pn: fromJid.split("@")[0] ?? null,
      push_name: "wa-smoke",
    },
    from_me: false,
    timestamp: now.toISOString(),
    type: "text",
    text,
    mentioned_self: isGroup, // groups only trigger on @mention
  } satisfies MessagePayload,
};

const rawBody = Buffer.from(JSON.stringify(envelope), "utf8");
const expectedMac = createHmac("sha256", webhookSecret)
  .update(`${tsSec}.`)
  .update(rawBody)
  .digest("hex");
const signature = `sha256=${expectedMac}`;
const webhookId = `smoke-${randomUUID()}`;

console.log(`→ POST  (id=${webhookId}, trigger_seq=${triggerSeq})`);

const postRes = await fetch(target, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-id": webhookId,
    "x-webhook-event": "message.received",
    "x-webhook-timestamp": String(tsSec),
    "x-webhook-signature": signature,
  },
  body: rawBody,
});

console.log(`  ← ${postRes.status} ${postRes.statusText}`);
if (postRes.status >= 300) {
  console.error("FATAL: webhook POST failed:", await postRes.text());
  process.exit(4);
}

/* ---------- 3) poll the bot until we see a new from_me message ---------- */

const deadline = Date.now() + timeoutMs;
let pollIntervalMs = 1000;
let detected: MessagePayload | null = null;

while (Date.now() < deadline) {
  await delay(pollIntervalMs);
  try {
    const after = await botFetchMessages();
    for (const m of after.messages) {
      if (!m.from_me) continue;
      if (m.seq <= beforeMaxSeq) continue;
      detected = m;
      break;
    }
  } catch (err) {
    console.warn(
      `  poll error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (detected) break;
  pollIntervalMs = Math.min(Math.floor(pollIntervalMs * 1.2), 5000);
}

if (!detected) {
  console.error(
    `FAIL: no agent reply observed within ${timeoutMs}ms (chat=${chatJid}, ` +
      `beforeMaxSeq=${beforeMaxSeq})`,
  );
  process.exit(1);
}

const elapsedMs = Date.now() - tsSec * 1000;
const replyText =
  typeof detected.text === "string" && detected.text
    ? detected.text
    : "(non-text)";
console.log(
  `OK: agent reply seen — seq=${detected.seq}, type=${detected.type}, ` +
    `wait≈${elapsedMs}ms, text="${replyText.slice(0, 200)}"`,
);
process.exit(0);
