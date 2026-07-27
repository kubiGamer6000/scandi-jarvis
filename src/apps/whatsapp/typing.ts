import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type { WhatsappClient } from "./client.js";

const log = createLogger("apps/whatsapp/typing");

/** Consecutive keepalive failures before we stop trying for this run. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface TypingIndicator {
  /** Close the session. Idempotent and never throws. */
  stop(): Promise<void>;
}

const NOOP_INDICATOR: TypingIndicator = { stop: async () => {} };

/**
 * Shows "typing…" in a chat for as long as a run is in flight.
 *
 * The WhatsApp chatstate expires after ~10s, but refreshing it is the bot's
 * job (see `src/presence/typing.ts` in scandi-wa-bot) — from here we only open
 * the session and re-assert it well inside its TTL, so a crashed or wedged
 * Jarvis can't leave a chat typing indefinitely.
 *
 * The bot also drops the session the moment it sends a message to the chat, so
 * the indicator disappears with the reply instead of lingering after it. If the
 * agent keeps working after sending (multi-message turns), the next keepalive
 * re-opens it, which reads exactly like a person typing again.
 */
export function startTypingIndicator(args: {
  client: WhatsappClient;
  chatJid: string;
  /** Run abort signal — aborting stops the indicator. */
  signal?: AbortSignal;
}): TypingIndicator {
  if (env.JARVIS_WA_TYPING_ENABLED !== "true") return NOOP_INDICATOR;

  const { client, chatJid, signal } = args;
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  /** In-flight POST, so `stop()` can't be overtaken by its own start call. */
  let inflight: Promise<void> = Promise.resolve();

  // The keepalive must never inherit the run's signal: when a run is aborted
  // we still want the DELETE to land so the chat stops showing "typing…".
  const assert = async (): Promise<void> => {
    if (stopped) return;
    try {
      await client.startTyping(chatJid, { ttlMs: env.JARVIS_WA_TYPING_TTL_MS });
      failures = 0;
    } catch (err) {
      failures += 1;
      log.debug("typing keepalive failed", {
        chat_jid: chatJid,
        failures,
        error: err instanceof Error ? err.message : String(err),
      });
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        log.warn("giving up on typing indicator", {
          chat_jid: chatJid,
          failures,
        });
        stopped = true;
      }
    }
  };

  const tick = (): Promise<void> => {
    inflight = assert();
    return inflight;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().then(schedule);
    }, env.JARVIS_WA_TYPING_KEEPALIVE_MS);
    timer.unref?.();
  };

  void tick().then(schedule);

  let stopping: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    stopping = (async () => {
      // A start call racing us would otherwise re-open the session after the
      // DELETE and leave the chat typing until the TTL lapses.
      await inflight.catch(() => undefined);
      try {
        await client.stopTyping(chatJid);
      } catch (err) {
        log.debug("failed to clear typing indicator", {
          chat_jid: chatJid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return stopping;
  };

  signal?.addEventListener("abort", () => void stop(), { once: true });

  return { stop };
}
