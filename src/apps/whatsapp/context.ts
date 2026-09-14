import { randomUUID } from "node:crypto";

import { HumanMessage } from "@langchain/core/messages";

import { getPool } from "../../core/db.js";
import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type { WhatsappClient } from "./client.js";
import { waitForRecentMedia } from "./media-wait.js";
import { formatMessageLine } from "./transcript.js";
import { normaliseChatType, type MessagePayload } from "./types.js";

const log = createLogger("apps/whatsapp/context");

/**
 * Per-run context bundle the runner constructs and stuffs into a single
 * `HumanMessage` at the top of the conversation. We do NOT rely on LangGraph's
 * checkpointed message history for WA content (it would balloon and bake
 * stale messages into the prompt); instead we re-derive context fresh for
 * every run, so the LLM always sees the current state of the chat.
 */
export interface BuildContextOptions {
  client: WhatsappClient;
  chatJid: string;
  triggeringSeq: number;
  /** How many recent messages to include in the transcript window. */
  recentLimit?: number;
  /** Pre-fetched triggering message (avoids a redundant fetch). */
  triggeringMessage?: MessagePayload | null;
  /** When false, skip the summaries fetch entirely (used by tests / cron). */
  includeSummaries?: boolean;
  /**
   * Continuing an existing agent session: only messages with a seq above
   * this are rendered (the thread already holds everything before), and the
   * summaries / notes are skipped. 0 or unset = full context.
   */
  sinceSeq?: number;
  /** When false, skip media-wait polling (used by tests / cron). */
  waitForMedia?: boolean;
  /** Forwarded to media-wait + nested fetches. */
  signal?: AbortSignal;
}

export interface BuiltContext {
  /** The single HumanMessage to feed into `agent.invoke({ messages: [...] })`. */
  message: HumanMessage;
  /** Raw bag the runner can use for logging / tracing. */
  meta: {
    chat_jid: string;
    chat_type: "dm" | "group";
    triggering_seq: number;
    transcript_msgs: number;
    /** How many of those transcript messages are our own outbound replies. */
    transcript_own_msgs: number;
    has_daily_summary: boolean;
    has_weekly_summary: boolean;
    has_longterm_summary: boolean;
    notes_len: number;
    /** "full" for a session's first run, "delta" when continuing one. */
    mode: "full" | "delta";
    /** Highest seq in the rendered window (feeds the next delta). */
    last_seq: number;
  };
  /** The triggering message in case the runner needs to inspect it further. */
  triggeringMessage: MessagePayload | null;
}

interface ChatContextRow {
  daily_summary: string | null;
  weekly_summary: string | null;
  longterm_summary: string | null;
  notes: string;
}

async function loadChatContextRow(
  chatJid: string,
): Promise<ChatContextRow | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query<ChatContextRow>(
      `select daily_summary, weekly_summary, longterm_summary, coalesce(notes, '') as notes
         from jarvis.chat_context
        where chat_jid = $1`,
      [chatJid],
    );
    return res.rows[0] ?? null;
  } catch (err) {
    log.warn("loadChatContextRow failed", {
      chat_jid: chatJid,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function buildContext(
  opts: BuildContextOptions,
): Promise<BuiltContext> {
  const recentLimit = opts.recentLimit ?? env.JARVIS_WA_CONTEXT_MSGS;
  const sinceSeq = opts.sinceSeq ?? 0;
  const mode: "full" | "delta" = sinceSeq > 0 ? "delta" : "full";
  const includeSummaries = (opts.includeSummaries ?? true) && mode === "full";

  // Everything below is independent I/O — fetch it concurrently. Summaries
  // are read as-is: they're refreshed in the background (summaries.ts), never
  // on the reply path.
  const [trigger, recentRaw, row] = await Promise.all([
    // 1. Triggering message (so we know who/what kicked this off).
    opts.triggeringMessage
      ? Promise.resolve(opts.triggeringMessage)
      : opts.client.getMessage(opts.triggeringSeq).catch((err) => {
          log.warn("getMessage(triggering) failed", {
            seq: opts.triggeringSeq,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
    // 2. Recent transcript window (before AND including the triggering seq).
    // The bot returns these newest-first when paged with `before_seq`; we
    // want oldest-first in the prompt.
    opts.client
      .fetchMessages(opts.chatJid, {
        before_seq: opts.triggeringSeq + 1, // inclusive of trigger
        limit: recentLimit,
        include_media: true,
        include_reactions: true,
        include_tombstones: false,
      })
      .then((res) => (res.ascending ? res.messages : [...res.messages].reverse()))
      .catch((err) => {
        log.warn("fetchMessages(recent) failed", {
          chat_jid: opts.chatJid,
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as MessagePayload[];
      }),
    // 3. Persistent context (summaries + notes).
    includeSummaries ? loadChatContextRow(opts.chatJid) : Promise.resolve(null),
  ]);

  // In a continuing session the thread already has everything up to
  // `sinceSeq`; only render what's new.
  let recent = mode === "delta" ? recentRaw.filter((m) => m.seq > sinceSeq) : recentRaw;
  const possiblyTruncated =
    mode === "delta" && recentRaw.length >= recentLimit && (recentRaw[0]?.seq ?? 0) > sinceSeq;

  // 2a. Wait for any unprocessed media in the window. The runner already
  // waited on the trigger; this catches e.g. a voice note 2 messages back
  // that hasn't been transcribed yet.
  if (opts.waitForMedia !== false && recent.length > 0) {
    try {
      recent = await waitForRecentMedia(opts.client, recent, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (!opts.signal?.aborted) {
        log.warn("waitForRecentMedia failed", {
          chat_jid: opts.chatJid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Compose the prompt block. The bot may return non-canonical chat.type
  // values (e.g. "lid" for LID-addressed DMs) — normalise to the {dm,group}
  // discriminator our schema accepts.
  const chatType = normaliseChatType(trigger?.chat.type, opts.chatJid);
  const subject = trigger?.chat.subject ?? null;
  const participantCount = trigger?.chat.participant_count ?? null;
  const triggerLine = trigger ? formatMessageLine(trigger) : `(seq=${opts.triggeringSeq} could not be fetched)`;

  // Single text block. We previously split this into a static+dynamic pair
  // with an Anthropic `cache_control` marker on the static prefix, but
  // DeepAgents already places cache breakpoints on the system prompt /
  // tools / skills middleware, and Anthropic caps the total at 4 per
  // request. Adding a 5th here yielded `400: A maximum of 4 blocks with
  // cache_control may be provided.`. Leave caching to the upstream
  // middleware and keep our prompt block as one chunk.
  const parts: string[] = [];

  parts.push(
    [
      "# WhatsApp run context",
      "",
      `chat_jid: ${opts.chatJid}`,
      `chat_type: ${chatType}`,
      subject ? `chat_subject: ${subject}` : null,
      participantCount !== null ? `participants: ${participantCount}` : null,
      `now: ${new Date().toISOString()}`,
      `triggering_seq: ${opts.triggeringSeq}`,
    ]
      .filter((s): s is string => s !== null)
      .join("\n"),
  );

  if (row?.longterm_summary?.trim()) {
    parts.push(`## Long-term summary (everything older than this week)\n${row.longterm_summary.trim()}`);
  }
  if (row?.weekly_summary?.trim()) {
    parts.push(`## Weekly summary (past ~7 days)\n${row.weekly_summary.trim()}`);
  }
  if (row?.daily_summary?.trim()) {
    parts.push(`## Daily summary (past ~24h)\n${row.daily_summary.trim()}`);
  }
  if (row?.notes?.trim()) {
    parts.push(`## Chat notes (your AGENTS.md for this chat)\n${row.notes.trim()}`);
  }

  if (mode === "delta") {
    const lines = recent.map(formatMessageLine).join("\n");
    parts.push(
      `## New messages since your last turn (${recent.length}, oldest first)\n` +
        (possiblyTruncated
          ? "(more messages arrived than shown — use `whatsapp_fetch_messages` if you need the earlier ones)\n"
          : "") +
        (lines || "(none besides the trigger)"),
    );
  } else if (recent.length > 0) {
    const lines = recent.map(formatMessageLine).join("\n");
    parts.push(`## Recent transcript (last ${recent.length}, oldest first)\n${lines}`);
  } else {
    parts.push("## Recent transcript\n(no recent messages available)");
  }

  parts.push(`## Triggering message\n${triggerLine}`);

  if (mode === "full") parts.push(
    "## What to do\n" +
      "Decide whether and how to respond. Use `whatsapp_send_message` to reply (the user only sees those — your AIMessage text is internal). " +
      "Use other WhatsApp tools as needed (`whatsapp_react`, `whatsapp_pull_file`, `whatsapp_remember`, etc.). " +
      "When you're done, end the turn (no final AIMessage required).",
  );
  else parts.push("## What to do\nSame as before: reply with WhatsApp tools, then end the turn.");

  const message = new HumanMessage({ id: randomUUID(), content: parts.join("\n\n") });

  const ownInTranscript = recent.filter((m) => m.from_me).length;

  return {
    message,
    meta: {
      chat_jid: opts.chatJid,
      chat_type: chatType,
      triggering_seq: opts.triggeringSeq,
      transcript_msgs: recent.length,
      transcript_own_msgs: ownInTranscript,
      has_daily_summary: Boolean(row?.daily_summary?.trim()),
      has_weekly_summary: Boolean(row?.weekly_summary?.trim()),
      has_longterm_summary: Boolean(row?.longterm_summary?.trim()),
      notes_len: row?.notes?.length ?? 0,
      mode,
      last_seq: Math.max(opts.triggeringSeq, ...recentRaw.map((m) => m.seq)),
    },
    triggeringMessage: trigger,
  };
}

