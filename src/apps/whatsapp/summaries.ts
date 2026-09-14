import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { getPool } from "../../core/db.js";
import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";
import { resolveModel } from "../../core/models.js";

import type { WhatsappClient } from "./client.js";
import { formatMessageLine } from "./transcript.js";
import type { MessagePayload } from "./types.js";

const log = createLogger("apps/whatsapp/summaries");

export type SummaryKind = "daily" | "weekly" | "longterm";

interface SummaryRow {
  chat_jid: string;
  daily_summary: string | null;
  daily_updated_at: Date | null;
  daily_through_seq: number | null;
  weekly_summary: string | null;
  weekly_updated_at: Date | null;
  weekly_through_seq: number | null;
  longterm_summary: string | null;
  longterm_updated_at: Date | null;
  longterm_through_seq: number | null;
}

/**
 * Per-summary refresh policy. A summary is rewritten when enough new messages
 * have piled up since its watermark, or when it's old and anything new exists.
 * Small gaps don't matter: the reply path always includes the recent
 * transcript on top of the summaries.
 *
 * Token ceilings are budgets we pass to the LLM, not hard limits.
 */
interface SummaryPolicy {
  /** Refresh once at least this many new messages exist… */
  minNewMessages: number;
  /** …or once the summary is older than this and has any new message. */
  maxAgeMs: number;
  /** Max messages to fetch when building the prompt (paginated). */
  fetchLimit: number;
  /** Output token ceiling (passed in the prompt). */
  outputTokenCeiling: number;
}

const POLICIES: Record<SummaryKind, SummaryPolicy> = {
  daily: {
    minNewMessages: 15,
    maxAgeMs: 3 * 60 * 60 * 1000, // 3h
    fetchLimit: 400,
    outputTokenCeiling: 800,
  },
  weekly: {
    minNewMessages: 60,
    maxAgeMs: 24 * 60 * 60 * 1000, // 24h
    fetchLimit: 1500,
    outputTokenCeiling: 1500,
  },
  longterm: {
    minNewMessages: 300,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7d
    fetchLimit: 5000,
    outputTokenCeiling: 2500,
  },
};

const SYSTEM_PROMPT = `You are a meticulous WhatsApp chat summariser. You will receive:
  1. The CURRENT summary of this chat (for the same time window).
  2. A list of NEW messages that arrived since the summary was last updated.
You will return an UPDATED summary that integrates the new messages into the existing summary.

Principles:
  - Preserve named entities, decisions, outstanding action items, contact info, and any factual specifics the agent might need to look up later.
  - Drop chit-chat. Keep substance.
  - Prefer a structured layout: bullet sections like "Participants", "Topics discussed", "Decisions / commitments", "Open questions / TODOs", "Useful facts". Use them only when they have content.
  - Use ISO dates / times when timing matters. Otherwise relative phrases are fine.
  - Be concise but information-dense. Aim for roughly the output token ceiling provided; never wildly exceed it.
  - Do NOT include the messages themselves verbatim — summarise.
  - If the new messages contradict the summary, the new messages win; update accordingly.`;

interface RefreshResult {
  changed: boolean;
  summary: string;
  through_seq: number;
  reason: "fresh" | "no-new-messages" | "updated";
}

interface RefreshOptions {
  client: WhatsappClient;
  chatJid: string;
  /** Forces a refresh regardless of staleness; used by the cron worker. */
  force?: boolean;
  /** Override policy thresholds (used by the cron worker to lower thresholds). */
  policy?: Partial<SummaryPolicy>;
  signal?: AbortSignal;
}

async function loadRow(chatJid: string): Promise<SummaryRow | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const res = await pool.query<SummaryRow>(
      `select chat_jid, daily_summary, daily_updated_at, daily_through_seq,
              weekly_summary, weekly_updated_at, weekly_through_seq,
              longterm_summary, longterm_updated_at, longterm_through_seq
         from jarvis.chat_context
        where chat_jid = $1`,
      [chatJid],
    );
    return res.rows[0] ?? null;
  } catch (err) {
    log.warn("loadRow failed", {
      chat_jid: chatJid,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function saveSummary(
  chatJid: string,
  kind: SummaryKind,
  summary: string,
  throughSeq: number,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const col = {
    daily: ["daily_summary", "daily_updated_at", "daily_through_seq"],
    weekly: ["weekly_summary", "weekly_updated_at", "weekly_through_seq"],
    longterm: ["longterm_summary", "longterm_updated_at", "longterm_through_seq"],
  }[kind];
  await pool.query(
    `insert into jarvis.chat_context (chat_jid, ${col[0]}, ${col[1]}, ${col[2]})
     values ($1, $2, now(), $3)
     on conflict (chat_jid) do update set
       ${col[0]} = excluded.${col[0]},
       ${col[1]} = excluded.${col[1]},
       ${col[2]} = excluded.${col[2]}
     -- Never move a watermark backwards (a slower concurrent refresh).
     where jarvis.chat_context.${col[2]} is null
        or jarvis.chat_context.${col[2]} < excluded.${col[2]}`,
    [chatJid, summary, throughSeq],
  );
}

async function fetchSince(
  client: WhatsappClient,
  chatJid: string,
  afterSeq: number,
  limit: number,
  signal?: AbortSignal,
): Promise<MessagePayload[]> {
  const out: MessagePayload[] = [];
  // The bot validates `after_seq >= 1`. When we have no prior watermark (first
  // summary run for this chat) `afterSeq` is 0 — clamp to 0 (meaning "every
  // message from the start") by NOT passing the param. We achieve that by
  // starting cursor at 1 and treating cursor<=0 as "from the beginning"
  // through omission of the field.
  let cursor = afterSeq;
  while (out.length < limit) {
    const remaining = limit - out.length;
    const params: Parameters<typeof client.fetchMessages>[1] = {
      limit: Math.min(100, remaining),
      include_media: true,
      include_reactions: true,
      include_tombstones: false,
    };
    if (cursor >= 1) {
      params.after_seq = cursor;
    }
    const batch = await client.fetchMessages(
      chatJid,
      params,
      signal ? { signal } : {},
    );
    if (batch.messages.length === 0) break;
    // When we paginated WITHOUT after_seq, the bot defaults to newest-first.
    // Reverse so we still build an oldest-first window.
    const ordered = cursor < 1 ? [...batch.messages].reverse() : batch.messages;
    out.push(...ordered);
    if (batch.next_after_seq === null) break;
    cursor = batch.next_after_seq;
  }
  return out;
}

async function llmUpdateSummary(
  kind: SummaryKind,
  prevSummary: string | null,
  newMessages: MessagePayload[],
  policy: SummaryPolicy,
  signal?: AbortSignal,
): Promise<string> {
  const model = await resolveModel({ model: env.JARVIS_SUMMARY_MODEL });
  const transcript = newMessages.map(formatMessageLine).join("\n");
  const human = new HumanMessage({
    content:
      `Window: ${kind}\n` +
      `Output token ceiling: ~${policy.outputTokenCeiling}\n\n` +
      `## Current summary\n${prevSummary?.trim() || "(none yet — produce from scratch)"}\n\n` +
      `## New messages (${newMessages.length})\n${transcript}\n\n` +
      "## Updated summary\n",
  });
  const res = await model.invoke(
    [new SystemMessage({ content: SYSTEM_PROMPT }), human],
    signal ? { signal } : undefined,
  );
  const out = typeof res.content === "string"
    ? res.content
    : Array.isArray(res.content)
      ? res.content
          .map((c) =>
            typeof c === "string"
              ? c
              : c && typeof c === "object" && "text" in c
                ? String((c as { text: unknown }).text ?? "")
                : "",
          )
          .join("\n")
      : "";
  return out.trim();
}

async function refresh(
  kind: SummaryKind,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const policy = { ...POLICIES[kind], ...(opts.policy ?? {}) };

  const row = await loadRow(opts.chatJid);
  const prevSummary =
    (kind === "daily"
      ? row?.daily_summary
      : kind === "weekly"
        ? row?.weekly_summary
        : row?.longterm_summary) ?? null;
  const prevThroughSeq =
    Number(
      kind === "daily"
        ? row?.daily_through_seq
        : kind === "weekly"
          ? row?.weekly_through_seq
          : row?.longterm_through_seq,
    ) || 0;
  const updatedAt =
    kind === "daily"
      ? row?.daily_updated_at
      : kind === "weekly"
        ? row?.weekly_updated_at
        : row?.longterm_updated_at;

  const age = updatedAt ? Date.now() - updatedAt.getTime() : Number.POSITIVE_INFINITY;
  const dueRegardless = Boolean(opts.force) || !prevSummary || age > policy.maxAgeMs;

  // Message seqs are global across chats, so staleness is measured by
  // fetching this chat's messages past the watermark, not by seq arithmetic.
  // When only the message count can make it due, fetch just enough to tell.
  const probeLimit = dueRegardless ? policy.fetchLimit : policy.minNewMessages;
  let newMessages = await fetchSince(
    opts.client,
    opts.chatJid,
    prevThroughSeq,
    probeLimit,
    opts.signal,
  );

  const unchanged = (reason: RefreshResult["reason"]): RefreshResult => ({
    changed: false,
    summary: prevSummary ?? "",
    through_seq: prevThroughSeq,
    reason,
  });
  if (newMessages.length === 0) return unchanged("no-new-messages");
  if (!dueRegardless && newMessages.length < policy.minNewMessages) return unchanged("fresh");
  if (probeLimit < policy.fetchLimit) {
    newMessages = await fetchSince(
      opts.client,
      opts.chatJid,
      prevThroughSeq,
      policy.fetchLimit,
      opts.signal,
    );
  }

  log.info("refreshing summary", {
    chat_jid: opts.chatJid,
    kind,
    new_messages: newMessages.length,
    prev_through_seq: prevThroughSeq,
  });

  let updated: string;
  try {
    updated = await llmUpdateSummary(kind, prevSummary, newMessages, policy, opts.signal);
  } catch (err) {
    log.warn("llm update failed; keeping previous summary", {
      chat_jid: opts.chatJid,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      changed: false,
      summary: prevSummary ?? "",
      through_seq: prevThroughSeq,
      reason: "fresh",
    };
  }
  const newThroughSeq = newMessages[newMessages.length - 1]!.seq;
  await saveSummary(opts.chatJid, kind, updated, newThroughSeq);

  return {
    changed: true,
    summary: updated,
    through_seq: newThroughSeq,
    reason: "updated",
  };
}

export function refreshDailyIfStale(opts: RefreshOptions): Promise<RefreshResult> {
  return refresh("daily", opts);
}

export function refreshWeeklyIfStale(opts: RefreshOptions): Promise<RefreshResult> {
  return refresh("weekly", opts);
}

export function refreshLongTermIfStale(opts: RefreshOptions): Promise<RefreshResult> {
  return refresh("longterm", opts);
}

/**
 * Run all three refreshes for a chat. They touch separate columns, so they
 * run concurrently. Called by the background scheduler below and the cron.
 */
export async function refreshAllIfStale(
  opts: RefreshOptions,
): Promise<{ daily: RefreshResult; weekly: RefreshResult; longterm: RefreshResult }> {
  const [daily, weekly, longterm] = await Promise.all([
    refreshDailyIfStale(opts),
    refreshWeeklyIfStale(opts),
    refreshLongTermIfStale(opts),
  ]);
  return { daily, weekly, longterm };
}

// ---------------------------------------------------------------------------
// Background scheduling
// ---------------------------------------------------------------------------

const pendingRefresh = new Map<string, NodeJS.Timeout>();
const runningRefresh = new Set<string>();

/**
 * Refresh a chat's summaries in the background once it has been quiet for
 * `JARVIS_SUMMARY_IDLE_MS`. Each new call resets the timer, so an active
 * conversation is summarised once it pauses, never in the middle of a reply.
 * At most one refresh per chat runs at a time.
 */
export function scheduleSummaryRefresh(client: WhatsappClient, chatJid: string): void {
  if (!getPool()) return;
  const existing = pendingRefresh.get(chatJid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingRefresh.delete(chatJid);
    if (runningRefresh.has(chatJid)) {
      scheduleSummaryRefresh(client, chatJid);
      return;
    }
    runningRefresh.add(chatJid);
    const t0 = Date.now();
    refreshAllIfStale({ client, chatJid })
      .then((r) => {
        const changed = (Object.keys(r) as SummaryKind[]).filter((k) => r[k].changed);
        if (changed.length > 0) {
          log.info("background summary refresh done", {
            chat_jid: chatJid,
            changed,
            duration_ms: Date.now() - t0,
          });
        }
      })
      .catch((err) =>
        log.warn("background summary refresh failed", {
          chat_jid: chatJid,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => runningRefresh.delete(chatJid));
  }, env.JARVIS_SUMMARY_IDLE_MS);
  timer.unref();
  pendingRefresh.set(chatJid, timer);
}
