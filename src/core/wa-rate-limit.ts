import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

import { env } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("core/wa-rate-limit");

/**
 * Tools we rate-limit. Read-only tools (`fetch`, `get`, `pull`, `remember`)
 * are unlimited; only user-visible outbound actions are gated.
 */
const RATE_LIMITED_TOOLS = new Set([
  "whatsapp_send_message",
  "whatsapp_react",
  "whatsapp_edit_message",
  "whatsapp_send_file",
]);

export interface WhatsappRateLimitOptions {
  /** Total outbound calls allowed within a single agent run. */
  maxSendsPerRun?: number;
  /** Minimum wall-time between two outbound calls (ms). */
  minIntervalMs?: number;
}

/**
 * Belt-and-braces middleware to keep a runaway agent from flooding a chat.
 *
 * - Per-run counter: bumped on every rate-limited tool call. Once it exceeds
 *   `maxSendsPerRun` we short-circuit further calls with a synthetic
 *   ToolMessage that tells the agent to stop and try sending a final summary
 *   instead.
 * - Per-run pacing: enforces `minIntervalMs` between two calls by sleeping
 *   inside the wrap. Cheap to implement and avoids spamming.
 *
 * State is per-run (per agent invocation) via a closure over `runId` extracted
 * from `runtime.config.runId`, falling back to `runtime.toolCallId` if absent.
 */
export function createWhatsappRateLimitMiddleware(
  options: WhatsappRateLimitOptions = {},
) {
  const maxSends = options.maxSendsPerRun ?? env.JARVIS_WA_MAX_SENDS_PER_RUN;
  const minInterval = options.minIntervalMs ?? env.JARVIS_WA_MIN_SEND_INTERVAL_MS;

  // Per-run counters; entries auto-evict after 10 minutes of inactivity.
  const counters = new Map<
    string,
    { count: number; lastCallAt: number; expiresAt: number }
  >();

  setInterval(
    () => {
      const now = Date.now();
      for (const [k, v] of counters) {
        if (v.expiresAt < now) counters.delete(k);
      }
    },
    60_000,
  ).unref();

  return createMiddleware({
    name: "WhatsappRateLimit",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall.name;
      if (!RATE_LIMITED_TOOLS.has(toolName)) {
        return handler(request);
      }

      const runId =
        (request.runtime as { config?: { runId?: string } }).config?.runId ??
        request.toolCall.id ??
        "unknown-run";
      const now = Date.now();
      const entry = counters.get(runId) ?? {
        count: 0,
        lastCallAt: 0,
        expiresAt: now + 10 * 60 * 1000,
      };
      entry.expiresAt = now + 10 * 60 * 1000;

      if (entry.count >= maxSends) {
        log.warn("hard cap reached", {
          tool: toolName,
          run_id: runId,
          count: entry.count,
          max: maxSends,
        });
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          name: toolName,
          content: JSON.stringify({
            ok: false,
            error: `whatsapp rate-limit: this run already made ${entry.count} outbound calls (max ${maxSends}). Stop sending more messages this turn — summarise and end the run.`,
          }),
        });
      }

      // Pacing: sleep if we're inside the min-interval window.
      const elapsed = now - entry.lastCallAt;
      if (entry.lastCallAt > 0 && elapsed < minInterval) {
        const sleepMs = minInterval - elapsed;
        log.debug("pacing", { tool: toolName, sleep_ms: sleepMs });
        await sleep(sleepMs, request.runtime.signal);
      }

      entry.count += 1;
      entry.lastCallAt = Date.now();
      counters.set(runId, entry);

      return handler(request);
    },
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve(); // resolve (don't reject) — the underlying tool call will see the signal too.
    };
    function cleanup() {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
