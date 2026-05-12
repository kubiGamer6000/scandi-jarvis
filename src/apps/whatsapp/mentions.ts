import type { MessagePayload } from "./types.js";

/**
 * Canonicalise a WhatsApp JID for stable comparison.
 *
 * Multi-device accounts sometimes use `user:device@s.whatsapp.net` while
 * mentions / `me` responses use `user@s.whatsapp.net`. Normalising strips the
 * optional `:device` segment from the local part.
 */
export function canonicalizeWaJid(jid: string): string {
  const s = jid.trim().toLowerCase();
  const at = s.indexOf("@");
  if (at < 0) return s;
  let user = s.slice(0, at);
  const host = s.slice(at + 1);
  const colon = user.indexOf(":");
  if (colon >= 0) user = user.slice(0, colon);
  return `${user}@${host}`;
}

export function jidMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return canonicalizeWaJid(a) === canonicalizeWaJid(b);
}

/**
 * True if this inbound message @-mentions the bot (PN or LID).
 *
 * Prefer the wa-bot's `mentioned_self` when correct; fall back to scanning
 * `mentioned_jids` with canonical JID matching — we've seen cases where the
 * bot's `detectMentionedSelf()` misses due to `user` vs `user:device` forms.
 */
export function messageMentionsBot(
  m: MessagePayload,
  self: { pnJid: string | null; lidJid: string | null },
): boolean {
  if (m.mentioned_self) return true;
  const jids = m.mentioned_jids;
  if (!jids?.length) return false;
  for (const mj of jids) {
    if (jidMatches(mj, self.pnJid)) return true;
    if (jidMatches(mj, self.lidJid)) return true;
  }
  return false;
}
