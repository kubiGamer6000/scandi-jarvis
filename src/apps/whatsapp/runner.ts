import { AIMessage } from "@langchain/core/messages";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";

import { createLogger } from "../../core/logger.js";
import { createToolTracer } from "../../core/tool-trace.js";
import type { WhatsappContext } from "../../tools/whatsapp/index.js";

import type { WhatsappAgent } from "./agent.js";
import type { WhatsappClient } from "./client.js";
import { buildContext } from "./context.js";
import { waitForMessageMedia } from "./media-wait.js";
import type { MessagePayload } from "./types.js";

const log = createLogger("apps/whatsapp/runner");

export interface RunOptions {
  agent: WhatsappAgent;
  client: WhatsappClient;
  chatJid: string;
  triggeringSeq: number;
  /** Pre-fetched triggering message if the dispatcher already has it. */
  triggeringMessage?: MessagePayload | null;
  /** Identity of the bot (so the agent knows its own JIDs). */
  self?: { pnJid?: string; lidJid?: string; accountId?: string } | null;
  /**
   * Abort signal from the dispatcher's per-chat AbortController. When this
   * fires (hard interrupt / /stop), the agent run cancels mid-flight.
   */
  signal?: AbortSignal;
}

export interface RunOutcome {
  ok: boolean;
  /** Whether the agent called `whatsapp_send_message` at least once. */
  sentMessage: boolean;
  /** Whether the run was aborted (signal fired). */
  aborted: boolean;
  /** Final AI text, if any (for the fallback safety net). */
  finalAiText: string | null;
  /** Tool calls observed (name → count). For logging / rate-limit auditing. */
  toolCallCounts: Record<string, number>;
  /** Number of messages in the resulting state. */
  messageCount: number;
  /** Total wall time. */
  durationMs: number;
  /** Optional error if the invoke threw (non-abort). */
  error?: string;
}

/**
 * Naive single-shot runner. Builds the per-run context, invokes the agent,
 * and returns an outcome the dispatcher can act on.
 *
 * What this does NOT do (yet, intentionally — wired in by later phases):
 *   - Media-wait polling (Phase 2.13)
 *   - Hard-interrupt retry loop (Phase 2.12 — that lives in dispatcher)
 *   - Fallback-final-send when sentMessage=false (Phase 4.23)
 */
export async function runOnce(opts: RunOptions): Promise<RunOutcome> {
  const t0 = Date.now();

  // If the trigger carries media we want the AI-summary to be in there before
  // we render the context block. buildContext also re-fetches the recent
  // window — `waitForRecentMedia` is invoked inside buildContext indirectly
  // via the same client, so we just block on the trigger here and let the
  // window proceed with whatever's available (a partially-processed window
  // is much less common than an unprocessed trigger).
  let triggerFresh: MessagePayload | null = opts.triggeringMessage ?? null;
  if (!triggerFresh || triggerFresh.media) {
    try {
      triggerFresh = await waitForMessageMedia(
        opts.client,
        opts.triggeringSeq,
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (err) {
      if (!opts.signal?.aborted) {
        log.warn("waitForMessageMedia failed", {
          chat_jid: opts.chatJid,
          seq: opts.triggeringSeq,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      triggerFresh = opts.triggeringMessage ?? null;
    }
  }

  if (opts.signal?.aborted) {
    return {
      ok: false,
      sentMessage: false,
      aborted: true,
      finalAiText: null,
      toolCallCounts: {},
      messageCount: 0,
      durationMs: Date.now() - t0,
    };
  }

  const built = await buildContext({
    client: opts.client,
    chatJid: opts.chatJid,
    triggeringSeq: opts.triggeringSeq,
    triggeringMessage: triggerFresh,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const context: WhatsappContext = {
    chatJid: opts.chatJid,
    chatType: built.meta.chat_type,
    triggeringSeq: opts.triggeringSeq,
    ...(opts.self?.accountId ? { accountId: opts.self.accountId } : {}),
    ...(opts.self?.pnJid ? { selfPnJid: opts.self.pnJid } : {}),
    ...(opts.self?.lidJid ? { selfLidJid: opts.self.lidJid } : {}),
    // Disable DeepAgents' auto Anthropic prompt-caching middleware. With our
    // long system prompt + chat-context HumanMessage + tools schema +
    // multiple historical turns, the auto-placer routinely tries to put more
    // than the Anthropic-mandated cap of 4 `cache_control` markers per
    // request, which 400s the run. We trade a tiny bit of cache reuse for
    // reliability. The remaining inline marker from
    // `createCacheBreakpointMiddleware` (1, on the system message) is fine.
    enableCaching: false,
  } as WhatsappContext & { enableCaching: false };

  log.info("invoke", {
    ...built.meta,
    self_pn: context.selfPnJid,
  });

  const tracer = createToolTracer({
    chat_jid: opts.chatJid,
    triggering_seq: opts.triggeringSeq,
  });
  const invokeConfig: {
    configurable: { thread_id: string };
    context: WhatsappContext;
    signal?: AbortSignal;
    tags: string[];
    metadata: Record<string, unknown>;
    callbacks: BaseCallbackHandler[];
  } = {
    configurable: { thread_id: opts.chatJid },
    context,
    tags: [
      "frontend:whatsapp",
      `chat_type:${built.meta.chat_type}`,
      `chat_jid:${opts.chatJid}`,
      ...(triggerFresh?.from.pn ? [`from_pn:${triggerFresh.from.pn}`] : []),
    ],
    metadata: {
      chat_jid: opts.chatJid,
      chat_type: built.meta.chat_type,
      triggering_seq: opts.triggeringSeq,
      transcript_msgs: built.meta.transcript_msgs,
      has_daily_summary: built.meta.has_daily_summary,
      has_weekly_summary: built.meta.has_weekly_summary,
      notes_len: built.meta.notes_len,
      ...(triggerFresh?.from.pn ? { from_pn: triggerFresh.from.pn } : {}),
      ...(triggerFresh?.from.jid ? { from_jid: triggerFresh.from.jid } : {}),
      ...(triggerFresh?.from.push_name ? { from_name: triggerFresh.from.push_name } : {}),
    },
    // Streams every tool call + result (including subagent / Composio /
    // base-tool calls that don't log via our own scoped logger) to stdout.
    callbacks: [tracer],
  };
  if (opts.signal) invokeConfig.signal = opts.signal;

  let result: { messages?: unknown[] } | undefined;
  let error: string | undefined;
  let aborted = false;
  try {
    result = (await opts.agent.invoke(
      { messages: [built.message] },
      invokeConfig,
    )) as { messages?: unknown[] };
  } catch (err) {
    if (
      (err instanceof Error && err.name === "AbortError") ||
      opts.signal?.aborted
    ) {
      aborted = true;
      log.info("run aborted", { chat_jid: opts.chatJid });
    } else {
      error = err instanceof Error ? err.message : String(err);
      log.error("run failed", { chat_jid: opts.chatJid, error });
    }
  }

  const toolCallCounts: Record<string, number> = {};
  let sentMessage = false;
  let finalAiText: string | null = null;

  if (result?.messages && Array.isArray(result.messages)) {
    for (const m of result.messages) {
      if (!m || typeof m !== "object") continue;
      const obj = m as {
        tool_calls?: Array<{ name?: string }>;
        _getType?: () => string;
        content?: unknown;
      };
      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          if (!tc?.name) continue;
          toolCallCounts[tc.name] = (toolCallCounts[tc.name] ?? 0) + 1;
          if (tc.name === "whatsapp_send_message") sentMessage = true;
        }
      }
    }
    finalAiText = lastAiText(result.messages);
  }

  // Safety net (Phase 4.23): if the agent finished a normal run but never
  // called `whatsapp_send_message`, and we have a substantive final AIMessage
  // text, send it as a fallback so the user isn't left without a reply. Skip
  // when aborted (a new message came in or /stop was issued; another run is
  // already restarting or the user explicitly asked us to stop).
  let fallbackSent = false;
  if (!aborted && !error && !sentMessage) {
    const text = (finalAiText ?? "").trim();
    if (text.length >= 2) {
      try {
        await opts.client.send({ to: opts.chatJid, text });
        fallbackSent = true;
        sentMessage = true;
        toolCallCounts["__fallback_send__"] = 1;
        log.warn("fallback final send", {
          chat_jid: opts.chatJid,
          text_len: text.length,
          reason: "agent never called whatsapp_send_message",
        });
      } catch (err) {
        log.error("fallback final send failed", {
          chat_jid: opts.chatJid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      log.warn("no whatsapp_send_message and no substantive final AI text", {
        chat_jid: opts.chatJid,
        final_ai_text_len: text.length,
      });
    }
  }

  const durationMs = Date.now() - t0;
  log.info("run complete", {
    chat_jid: opts.chatJid,
    ok: !error,
    aborted,
    sent_message: sentMessage,
    fallback_sent: fallbackSent,
    tool_call_counts: toolCallCounts,
    duration_ms: durationMs,
  });

  return {
    ok: !error,
    sentMessage,
    aborted,
    finalAiText,
    toolCallCounts,
    messageCount: Array.isArray(result?.messages) ? result.messages.length : 0,
    durationMs,
    ...(error ? { error } : {}),
  };
}

function lastAiText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const inst = m as AIMessage;
    const kind = (inst as { _getType?: () => string })._getType?.();
    if (kind !== "ai") continue;
    const c = (inst as { content?: unknown }).content;
    if (typeof c === "string" && c.trim()) return c;
    if (Array.isArray(c)) {
      const text = c
        .map((piece) =>
          typeof piece === "string"
            ? piece
            : piece && typeof piece === "object" && "text" in piece
              ? String((piece as { text: unknown }).text ?? "")
              : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
  }
  return null;
}
