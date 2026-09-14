import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type { WhatsappClient } from "./client.js";
import type { MessagePayload } from "./types.js";

const log = createLogger("apps/whatsapp/media-wait");

/**
 * If a message carries media, we want the WA bot's media-processing pipeline
 * (image / PDF / audio extract) to have finished before the agent sees it —
 * otherwise the transcript line is just `📎 image — (processing pending)` and
 * the LLM has nothing to react to.
 *
 * `waitForMessageMedia` polls `GET /v1/messages/:seq/media` with backoff up
 * to `JARVIS_WA_MEDIA_WAIT_MS` (default 60s) for ONE message. Returns the
 * message payload either way — caller decides what to do if it's still
 * pending after the timeout (the transcript renderer falls back to a
 * "processing pending" line, which the agent can still reason about).
 *
 * `waitForRecentMedia` runs the same check across the trigger + the last N
 * messages so we don't render a stale window where one media is processed
 * but a slightly older one isn't.
 */
export interface WaitForMediaOptions {
  /** Override the env default; mostly useful for tests. */
  maxWaitMs?: number;
  /** Initial backoff between polls (then 2x up to a 1.5s ceiling). */
  initialBackoffMs?: number;
  signal?: AbortSignal;
}

function needsWait(m: MessagePayload | null | undefined): boolean {
  if (!m) return false;
  const media = m.media;
  if (!media) return false;
  // No processing slot at all → we're done.
  // (Some kinds — stickers, GIFs — never get processed.)
  if (media.processed !== null && media.processed !== undefined) {
    return media.processed.text === null; // null text => still pending
  }
  // Brand new uploads have `processed === null` until the worker picks them up.
  // We can detect "in progress" via download_status as a fallback.
  return media.download_status === "pending" || media.download_status === "in_progress";
}

/** Media older than this in the context window is not waited on. */
const RECENT_MEDIA_MAX_AGE_MS = 5 * 60_000;
/** Non-trigger media gets a shorter wait than the triggering message. */
const RECENT_MEDIA_MAX_WAIT_MS = 20_000;

export async function waitForMessageMedia(
  client: WhatsappClient,
  seq: number,
  opts: WaitForMediaOptions = {},
): Promise<MessagePayload | null> {
  const maxWait = opts.maxWaitMs ?? env.JARVIS_WA_MEDIA_WAIT_MS;
  const start = Date.now();
  let backoff = opts.initialBackoffMs ?? 500;

  // Cheap first check; common case is the media is already processed.
  let current: MessagePayload | null = null;
  try {
    current = await client.getMessage(seq, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    log.debug("getMessage failed", {
      seq,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  while (needsWait(current) && Date.now() - start < maxWait) {
    if (opts.signal?.aborted) return current;
    log.debug("waiting on media", {
      seq,
      elapsed_ms: Date.now() - start,
      max_wait_ms: maxWait,
    });
    await sleep(backoff, opts.signal);
    // Short cap: getMessage is a local API call, and every second we sleep
    // past the moment the transcript lands is a second the user waits.
    backoff = Math.min(backoff * 2, 1_500);
    try {
      current = await client.getMessage(
        seq,
        opts.signal ? { signal: opts.signal } : {},
      );
    } catch (err) {
      log.debug("re-poll failed", {
        seq,
        error: err instanceof Error ? err.message : String(err),
      });
      // Keep the previous `current`; loop will exit on timeout if it keeps failing.
    }
  }

  if (needsWait(current)) {
    log.info("media still pending after timeout — proceeding anyway", {
      seq,
      max_wait_ms: maxWait,
    });
  }
  return current;
}

/**
 * Wait for any messages in `recent` that look like they're still being
 * processed. Trigger message is handled separately by `waitForMessageMedia`.
 *
 * Limit: we only wait on entries within the user-visible window (the same
 * messages that will get rendered into the context). Skip very old ones —
 * the AI summary almost certainly already exists; if it doesn't, it never will.
 */
export async function waitForRecentMedia(
  client: WhatsappClient,
  recent: MessagePayload[],
  opts: WaitForMediaOptions = {},
): Promise<MessagePayload[]> {
  // Only wait on media that arrived in the last few minutes. Older items that
  // are still unprocessed are stuck in a backlog or failed; waiting on them
  // stalled every reply in the chat by the full timeout.
  const now = Date.now();
  const pending = recent.filter(
    (m) => needsWait(m) && now - Date.parse(m.timestamp) < RECENT_MEDIA_MAX_AGE_MS,
  );
  if (pending.length === 0) return recent;

  log.info("polling unprocessed media", {
    pending_seqs: pending.map((m) => m.seq),
    total_in_window: recent.length,
  });

  const windowOpts: WaitForMediaOptions = {
    ...opts,
    maxWaitMs: Math.min(opts.maxWaitMs ?? env.JARVIS_WA_MEDIA_WAIT_MS, RECENT_MEDIA_MAX_WAIT_MS),
  };
  const updates = await Promise.all(
    pending.map(async (m) => {
      const fresh = await waitForMessageMedia(client, m.seq, windowOpts);
      return fresh ?? m;
    }),
  );

  // Merge back into `recent` preserving order.
  const byId = new Map<number, MessagePayload>();
  for (const u of updates) byId.set(u.seq, u);
  return recent.map((m) => byId.get(m.seq) ?? m);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    function cleanup() {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
