import { env } from "../../core/env.js";

let parsed: { all: boolean; set: Set<string> } | null = null;

function ensureParsed() {
  if (parsed) return parsed;
  const raw = env.JARVIS_WA_ALLOWED_CHATS.trim();
  if (raw === "*") {
    parsed = { all: true, set: new Set() };
  } else {
    const set = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    parsed = { all: false, set };
  }
  return parsed;
}

/**
 * Returns true if the given chat JID is on the operator's whitelist.
 *
 * - Default (`JARVIS_WA_ALLOWED_CHATS` unset): fail closed, returns false.
 * - `JARVIS_WA_ALLOWED_CHATS=*`: opens up everything (single-tenant / local
 *   dev). Use with care; the agent has tools that can send to ANY chat.
 * - Comma-separated JIDs: only those exact chats are allowed.
 */
export function isChatAllowed(chatJid: string): boolean {
  const cfg = ensureParsed();
  if (cfg.all) return true;
  return cfg.set.has(chatJid);
}

export function allowedChatCount(): number {
  const cfg = ensureParsed();
  return cfg.all ? -1 : cfg.set.size;
}
