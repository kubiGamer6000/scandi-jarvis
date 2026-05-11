/**
 * Smoke-tests the WhatsApp bot REST client (src/apps/whatsapp/client.ts)
 * against a live scandi-wa-bot instance.
 *
 * Usage:
 *   npm run smoke:wa-client            # health + me + recent chats only
 *   SEND_TO=359...@s.whatsapp.net npm run smoke:wa-client   # also sends a test message
 *
 * Required env (in .env or shell):
 *   WA_BOT_BASE_URL=http://127.0.0.1:8787
 *   WA_BOT_TOKEN=<the bot's API_AUTH_TOKEN>
 */
import { createWhatsappClient } from "../src/apps/whatsapp/client.js";
import { env, hasCredential } from "../src/core/env.js";

async function main() {
  if (!hasCredential("WA_BOT_BASE_URL") || !hasCredential("WA_BOT_TOKEN")) {
    console.error(
      "Skipping: WA_BOT_BASE_URL and WA_BOT_TOKEN must be set in .env (see .env.example).",
    );
    process.exit(2);
  }

  const client = createWhatsappClient();

  console.log(`>>> GET ${env.WA_BOT_BASE_URL}/v1/health`);
  const health = await client.health();
  console.log(JSON.stringify(health, null, 2));

  console.log("\n>>> GET /v1/me");
  const me = await client.me();
  console.log(JSON.stringify(me, null, 2));

  console.log("\n>>> GET /v1/chats (limit=5) — wa bot REST direct, no client wrapper here, skipping");

  if (process.env.SEND_TO) {
    console.log(`\n>>> POST /v1/send → ${process.env.SEND_TO}`);
    const res = await client.send({
      to: process.env.SEND_TO,
      text: "wa-client-smoke OK ✅",
    });
    console.log(JSON.stringify(res, null, 2));

    if (res.seq !== null) {
      console.log(`\n>>> POST /v1/messages/${res.seq}/react ('👍')`);
      await client.react(res.seq, "👍");
      console.log("ok");
    }
  } else {
    console.log("\n(skip send; set SEND_TO=<jid> to also send a test message)");
  }

  console.log("\nall good.");
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
