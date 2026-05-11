import type { MessagePayload } from "./types.js";

/**
 * Render a single MessagePayload as a one-line transcript entry suitable for
 * injection into the agent's HumanMessage prefix.
 *
 * Format:
 *   [seq=42 14:03] @alice (3597...43): hello world
 *   [seq=43 14:03] you: copy that
 *   [seq=44 14:04] @bob: 📎 image "selfie.jpg" — AI summary: a person holding a cup
 *   [seq=45 14:05 ↩42] @alice: ...replying to seq 42
 *
 * Constraints we honour:
 *   - one line per message (the LLM tolerates this fine and saves tokens),
 *   - `[seq=N]` markers so the model can quote-reply (`quote_seq=42`),
 *   - tombstones / deleted messages get a `🗑 (deleted)` placeholder so the
 *     model still understands the seq gap.
 */
export function formatMessageLine(msg: MessagePayload): string {
  const time = formatTime(msg.timestamp);
  const seqTag = `seq=${msg.seq}`;
  const refTag = msg.quoted?.seq ? ` ↩${msg.quoted.seq}` : "";
  const header = `[${seqTag} ${time}${refTag}]`;

  if (msg.deleted || msg.tombstone) {
    const reason = msg.deletion_reason ? ` (${msg.deletion_reason})` : "";
    return `${header} 🗑 (deleted${reason})`;
  }

  const sender = formatSender(msg);
  const body = formatBody(msg);
  return `${header} ${sender}: ${body}`.trimEnd();
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(11, 16); // HH:MM UTC
  } catch {
    return iso;
  }
}

function formatSender(msg: MessagePayload): string {
  if (msg.from_me) return "you";
  const name = msg.from.push_name?.trim();
  const handle = msg.from.pn ?? msg.from.jid;
  if (name && name.length > 0) {
    return `${name} (${handle})`;
  }
  return handle;
}

function formatBody(msg: MessagePayload): string {
  const parts: string[] = [];

  if (msg.media) {
    const media = msg.media;
    const kind = media.media_type || "media";
    const fname = media.file_name ? ` "${media.file_name}"` : "";
    const ai = media.processed?.text?.trim();
    const aiPart = ai
      ? ` — AI summary: ${truncate(singleLine(ai), 600)}`
      : media.download_status === "failed"
        ? " — (download failed)"
        : ai === undefined && media.processed === null
          ? " — (processing pending)"
          : "";
    parts.push(`📎 ${kind}${fname}${aiPart}`);
  }

  const text = msg.caption ?? msg.text;
  if (text && text.trim()) {
    parts.push(singleLine(text));
  }

  const edited = (msg.edit_count ?? 0) > 0 ? " (edited)" : "";

  const reactions = (msg.reactions ?? [])
    .filter((r) => r.emoji)
    .map((r) => r.emoji)
    .filter((e): e is string => Boolean(e));
  const reactSuffix = reactions.length > 0 ? `  [reactions: ${reactions.join(" ")}]` : "";

  if (parts.length === 0) {
    return `<${msg.type ?? "unknown"}>${edited}${reactSuffix}`;
  }
  return `${parts.join(" ")}${edited}${reactSuffix}`;
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
