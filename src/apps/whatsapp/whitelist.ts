import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type { MessagePayload } from "./types.js";

const log = createLogger("apps/whatsapp/whitelist");

/**
 * Who Jarvis is allowed to work for.
 *
 * Two independent gates, both checked before anything else happens — no agent
 * run, no typing indicator, no LLM call:
 *
 *   - `JARVIS_WA_ALLOWED_SENDERS` — the people. Phone numbers (or LIDs) that
 *     may talk to Jarvis, in DMs and in groups. Everyone else is ignored.
 *   - `JARVIS_WA_ALLOWED_CHATS` — the group chats Jarvis participates in.
 *     DMs don't need to be listed: an approved sender's DM is allowed by
 *     definition (and a DM's chat JID flips between PN and LID form, so
 *     listing it is unreliable anyway).
 *
 * Both default to empty, which means "nobody" — this fails closed. `*` opens
 * a gate completely and is for local development only: Jarvis reads live
 * business data and can message any chat.
 */

interface Gate {
  all: boolean;
  set: Set<string>;
}

function parseGate(raw: string): Gate {
  const value = raw.trim();
  if (value === "*") return { all: true, set: new Set() };
  return {
    all: false,
    set: new Set(
      value
        .split(",")
        .map((entry) => normaliseId(entry))
        .filter(Boolean),
    ),
  };
}

let chats: Gate | null = null;
let senders: Gate | null = null;

const chatGate = (): Gate => (chats ??= parseGate(env.JARVIS_WA_ALLOWED_CHATS));
const senderGate = (): Gate => (senders ??= parseGate(env.JARVIS_WA_ALLOWED_SENDERS));

/**
 * Reduce a WhatsApp identifier to something comparable.
 *
 * The same person arrives as `46768505515@s.whatsapp.net`, as
 * `173065942106213@lid`, and with a device suffix (`173065942106213:25@lid`),
 * so we compare the bare id: digits before `:` or `@`, no separators.
 */
export function normaliseId(value: string | null | undefined): string {
  if (!value) return "";
  const bare = value.trim().split("@")[0]?.split(":")[0] ?? "";
  return bare.replace(/\D/g, "");
}

/**
 * Returns true if the chat is one Jarvis may participate in. Group JIDs are
 * matched against `JARVIS_WA_ALLOWED_CHATS`; DMs are governed by the sender
 * gate instead (see {@link isSenderAllowed}).
 */
export function isChatAllowed(chatJid: string): boolean {
  const gate = chatGate();
  if (gate.all) return true;
  return gate.set.has(normaliseId(chatJid));
}

/**
 * Returns true if the message's sender is on the people allowlist. Checks
 * every identity form the bot may report for them.
 */
export function isSenderAllowed(from: MessagePayload["from"]): boolean {
  const gate = senderGate();
  if (gate.all) return true;
  for (const candidate of [from.pn, from.lid, from.jid]) {
    const id = normaliseId(candidate);
    if (id && gate.set.has(id)) return true;
  }
  return false;
}

/**
 * The single access decision for an inbound message: may Jarvis act on it at
 * all? Called by the dispatcher before any work is scheduled.
 */
export function isMessageAllowed(m: MessagePayload): boolean {
  if (!isSenderAllowed(m.from)) {
    log.info("ignoring message from sender not on the allowlist", {
      chat_jid: m.chat.jid,
      seq: m.seq,
      from: m.from.pn ?? m.from.jid,
      chat_type: m.chat.type,
    });
    return false;
  }
  const isGroup = m.chat.type === "group" || m.chat.jid.endsWith("@g.us");
  if (isGroup && !isChatAllowed(m.chat.jid)) {
    log.info("ignoring message in group not on the allowlist", {
      chat_jid: m.chat.jid,
      seq: m.seq,
      from: m.from.pn ?? m.from.jid,
    });
    return false;
  }
  return true;
}

/** Count of allowed group chats; -1 when unrestricted. For the health route. */
export function allowedChatCount(): number {
  const gate = chatGate();
  return gate.all ? -1 : gate.set.size;
}

/** Count of allowed senders; -1 when unrestricted. For the health route. */
export function allowedSenderCount(): number {
  const gate = senderGate();
  return gate.all ? -1 : gate.set.size;
}
