/**
 * Access-gate truth table for the WhatsApp frontend (no network, no LLM).
 *
 * Verifies that only approved people in approved chats can reach the agent,
 * using the real JID forms the bot reports: phone, LID, and LID with a
 * device suffix.
 *
 *   npm run check:access
 */
import { env } from "../src/core/env.js";
import { isMessageAllowed } from "../src/apps/whatsapp/whitelist.js";
import type { MessagePayload } from "../src/apps/whatsapp/types.js";

const OPS_GROUP = "120363419881705357@g.us";

// The configuration we run in production.
const mutable = env as Record<string, unknown>;
mutable.JARVIS_WA_ALLOWED_CHATS = OPS_GROUP;
mutable.JARVIS_WA_ALLOWED_SENDERS =
  "359884430293,46768505515,46704832998,187595850019032,173065942106213,215714799603744";

function msg(
  chatJid: string,
  chatType: "dm" | "group",
  from: { jid: string; pn?: string | null; lid?: string | null },
): MessagePayload {
  return {
    seq: 1,
    wa_id: "W1",
    chat: { jid: chatJid, type: chatType },
    from: { jid: from.jid, pn: from.pn ?? null, lid: from.lid ?? null },
    from_me: false,
    timestamp: new Date().toISOString(),
    type: "text",
    text: "hi",
    mentioned_self: true,
  };
}

const cases: Array<[string, MessagePayload, boolean]> = [
  // The three of us, in the ops group and in DMs, in every identity form.
  ["Veli in ops group (pn)", msg(OPS_GROUP, "group", { jid: "187595850019032@lid", pn: "359884430293@s.whatsapp.net" }), true],
  ["Elias in ops group (pn)", msg(OPS_GROUP, "group", { jid: "173065942106213@lid", pn: "46768505515@s.whatsapp.net" }), true],
  ["Javid in ops group (pn)", msg(OPS_GROUP, "group", { jid: "215714799603744@lid", pn: "46704832998@s.whatsapp.net" }), true],
  ["Veli DM (lid chat)", msg("187595850019032@lid", "dm", { jid: "187595850019032@lid", pn: "359884430293@s.whatsapp.net" }), true],
  ["Veli DM (pn chat)", msg("359884430293@s.whatsapp.net", "dm", { jid: "359884430293@s.whatsapp.net", pn: "359884430293@s.whatsapp.net" }), true],
  ["Elias DM (lid only, no pn reported)", msg("173065942106213@lid", "dm", { jid: "173065942106213@lid" }), true],
  ["Javid DM with device suffix", msg("215714799603744:25@lid", "dm", { jid: "215714799603744:25@lid" }), true],

  // Everyone else.
  ["stranger DM", msg("46700000001@s.whatsapp.net", "dm", { jid: "46700000001@s.whatsapp.net", pn: "46700000001@s.whatsapp.net" }), false],
  ["stranger DM (lid form)", msg("99999999999999@lid", "dm", { jid: "99999999999999@lid" }), false],
  ["stranger in ops group", msg(OPS_GROUP, "group", { jid: "205321565942003@lid", pn: "447960451664@s.whatsapp.net" }), false],
  ["Veli in an unapproved group", msg("120363427223510906@g.us", "group", { jid: "187595850019032@lid", pn: "359884430293@s.whatsapp.net" }), false],
  ["stranger in an unapproved group", msg("120363374717597053@g.us", "group", { jid: "46700000002@s.whatsapp.net", pn: "46700000002@s.whatsapp.net" }), false],
  ["WhatsApp system chat", msg("0@s.whatsapp.net", "dm", { jid: "0@s.whatsapp.net" }), false],
  // A number that merely *contains* an approved one must not pass.
  ["lookalike number", msg("1359884430293@s.whatsapp.net", "dm", { jid: "1359884430293@s.whatsapp.net", pn: "1359884430293@s.whatsapp.net" }), false],
];

let failures = 0;
for (const [name, payload, expected] of cases) {
  const actual = isMessageAllowed(payload);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${expected ? "allow" : "ignore"}: ${name}${ok ? "" : ` (got ${actual ? "allow" : "ignore"})`}`);
}

console.log(failures === 0 ? "\naccess gate correct" : `\n${failures} case(s) wrong`);
process.exit(failures === 0 ? 0 : 1);
