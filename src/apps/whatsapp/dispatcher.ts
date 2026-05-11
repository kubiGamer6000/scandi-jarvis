import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type { WhatsappAgent } from "./agent.js";
import type { WhatsappClient } from "./client.js";
import { parseCommand } from "./commands.js";
import { runOnce, type RunOutcome } from "./runner.js";
import type { MessagePayload } from "./types.js";
import { isChatAllowed } from "./whitelist.js";

const log = createLogger("apps/whatsapp/dispatcher");

export interface DispatchInput {
  message: MessagePayload;
}

export interface DispatcherDeps {
  agent: WhatsappAgent;
  client: WhatsappClient;
  self: { pnJid: string | null; lidJid: string | null; accountId: string };
}

/**
 * Per-chat state. The dispatcher owns one of these per active chat JID.
 *
 * States:
 *   - idle:          nothing happening; deleted from the Map after a brief grace period.
 *   - debouncing:    waiting `JARVIS_WA_DEBOUNCE_MS` quiet-time after the most
 *                    recent message before starting the run. `trigger` is the
 *                    latest message; new messages overwrite it and reset the timer.
 *   - running:       `agent.invoke` is in flight. `trigger` is what kicked it off.
 *                    A pending non-stop message during this state transitions to
 *                    "aborting".
 *   - aborting:      we've called `ac.abort()` because a new message landed mid-run.
 *                    Once the run settles, transition back to "debouncing" with the
 *                    pending message as the new trigger.
 *   - stoppingFinal: /stop received. Abort + send "I've stopped" once the run
 *                    settles. No auto-restart.
 */
type State =
  | { kind: "idle" }
  | {
      kind: "debouncing";
      trigger: MessagePayload;
      timer: NodeJS.Timeout;
    }
  | {
      kind: "running";
      trigger: MessagePayload;
      abort: AbortController;
      runPromise: Promise<RunOutcome>;
    }
  | {
      kind: "aborting";
      trigger: MessagePayload;
      abort: AbortController;
      runPromise: Promise<RunOutcome>;
      /** Latest message arrived during the abort wait. Becomes the next trigger. */
      pending: MessagePayload;
    }
  | {
      kind: "stoppingFinal";
      abort: AbortController;
      runPromise: Promise<RunOutcome> | null;
      stopTriggerSeq: number;
    };

interface ChatRecord {
  state: State;
}

/**
 * Per-chat dispatcher implementing the full Phase-2 state machine:
 *   debounce → hard-interrupt + auto-restart → /stop final-stop.
 *
 * - 5s debounce per chat: coalesces rapid-fire messages into one run.
 * - new non-/stop message during a run aborts it, reacts 🔄 on the new
 *   message, then restarts with fresh context (latest msg as trigger).
 * - /stop intercepts before the agent sees it: aborts, reacts 🛑, sends
 *   "I've stopped." directly via WA REST.
 * - drops messages from non-whitelisted chats, from the bot itself, group
 *   messages that don't mention the bot, and pure system events.
 */
export class Dispatcher {
  private readonly chats = new Map<string, ChatRecord>();
  private shuttingDown = false;

  constructor(private readonly deps: DispatcherDeps) {}

  /** Called once per incoming webhook (after dedupe). */
  ingest(input: DispatchInput): void {
    if (this.shuttingDown) return;
    const m = input.message;
    if (!this.shouldHandle(m)) return;

    const chatJid = m.chat.jid;
    const cmd = parseCommand(m.text);

    if (cmd.kind === "stop") {
      void this.handleStop(chatJid, m.seq);
      return;
    }

    this.handleRegular(chatJid, m);
  }

  /* ---------- transitions ---------- */

  private handleRegular(chatJid: string, m: MessagePayload): void {
    const rec = this.getOrCreate(chatJid);
    const s = rec.state;

    switch (s.kind) {
      case "idle":
        rec.state = this.startDebounce(chatJid, m);
        return;

      case "debouncing":
        // Reset the timer; latest message wins as the trigger.
        clearTimeout(s.timer);
        rec.state = this.startDebounce(chatJid, m);
        return;

      case "running": {
        // Hard interrupt. React 🔄 on the *new* message so user sees we got it,
        // abort, and stash pending so we restart with the latest trigger.
        log.info("hard interrupt", {
          chat_jid: chatJid,
          old_trigger_seq: s.trigger.seq,
          new_trigger_seq: m.seq,
        });
        s.abort.abort();
        this.fireAndForgetReact(m.seq, "🔄");
        rec.state = {
          kind: "aborting",
          trigger: s.trigger,
          abort: s.abort,
          runPromise: s.runPromise,
          pending: m,
        };
        // The aborting->debouncing handoff happens in awaitAbortThenRestart,
        // which is already running (chained from the original startRun).
        return;
      }

      case "aborting":
        // Already aborting; just update `pending` so the latest message
        // becomes the next trigger when we eventually restart.
        log.debug("update pending during abort", {
          chat_jid: chatJid,
          new_pending_seq: m.seq,
        });
        s.pending = m;
        this.fireAndForgetReact(m.seq, "🔄");
        return;

      case "stoppingFinal":
        // We're shutting this chat's current activity down via /stop.
        // Drop the message on the floor — the user explicitly asked us to stop.
        log.debug("dropping msg during stoppingFinal", {
          chat_jid: chatJid,
          seq: m.seq,
        });
        return;
    }
  }

  private async handleStop(chatJid: string, stopSeq: number): Promise<void> {
    const rec = this.getOrCreate(chatJid);
    const s = rec.state;
    log.info("/stop received", { chat_jid: chatJid, seq: stopSeq });

    // Abort any in-flight or queued work.
    let runPromise: Promise<RunOutcome> | null = null;
    let abortController: AbortController;
    switch (s.kind) {
      case "idle":
        abortController = new AbortController();
        break;
      case "debouncing":
        clearTimeout(s.timer);
        abortController = new AbortController();
        break;
      case "running":
        s.abort.abort();
        abortController = s.abort;
        runPromise = s.runPromise;
        break;
      case "aborting":
        // Already aborting; co-opt the existing abort + promise.
        abortController = s.abort;
        runPromise = s.runPromise;
        break;
      case "stoppingFinal":
        // Two /stops in a row — already stopping. Ignore.
        log.debug("duplicate /stop, ignoring", { chat_jid: chatJid });
        return;
    }

    rec.state = {
      kind: "stoppingFinal",
      abort: abortController,
      runPromise,
      stopTriggerSeq: stopSeq,
    };

    // React 🛑 and send the confirmation in parallel.
    void this.fireAndForgetReact(stopSeq, "🛑");
    try {
      await this.deps.client.send({
        to: chatJid,
        text: "Got it — I've stopped.",
      });
    } catch (err) {
      log.warn("send 'stopped' failed", {
        chat_jid: chatJid,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Wait for the underlying run to settle (best-effort, capped at 10s) and
    // then return to idle.
    if (runPromise) {
      await Promise.race([
        runPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    rec.state = { kind: "idle" };
    this.maybeReap(chatJid);
  }

  /* ---------- helpers ---------- */

  private startDebounce(chatJid: string, m: MessagePayload): State {
    const timer = setTimeout(() => {
      this.onDebounceFired(chatJid).catch((err) =>
        log.error("onDebounceFired threw", {
          chat_jid: chatJid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, env.JARVIS_WA_DEBOUNCE_MS);
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      // Allow the process to exit if nothing else is keeping it alive.
      (timer as { unref: () => void }).unref();
    }
    return { kind: "debouncing", trigger: m, timer };
  }

  private async onDebounceFired(chatJid: string): Promise<void> {
    const rec = this.chats.get(chatJid);
    if (!rec) return;
    if (rec.state.kind !== "debouncing") {
      // State changed underneath us (e.g. a /stop landed). Bail.
      return;
    }
    const trigger = rec.state.trigger;
    this.kickRun(chatJid, rec, trigger);
  }

  private kickRun(
    chatJid: string,
    rec: ChatRecord,
    trigger: MessagePayload,
  ): void {
    const abort = new AbortController();

    // No auto-ack reaction — the agent decides whether and how to react via
    // the `whatsapp_react` tool. The dispatcher still owns 🔄 (hard-interrupt
    // notice) and 🛑 (/stop ack) because those are infrastructure signals
    // the agent isn't in a position to send itself.

    const runPromise = runOnce({
      agent: this.deps.agent,
      client: this.deps.client,
      chatJid,
      triggeringSeq: trigger.seq,
      triggeringMessage: trigger,
      self: {
        ...(this.deps.self.pnJid ? { pnJid: this.deps.self.pnJid } : {}),
        ...(this.deps.self.lidJid ? { lidJid: this.deps.self.lidJid } : {}),
        accountId: this.deps.self.accountId,
      },
      signal: abort.signal,
    });

    rec.state = { kind: "running", trigger, abort, runPromise };
    log.info("run started", {
      chat_jid: chatJid,
      triggering_seq: trigger.seq,
    });

    // Tail the promise — when it settles, decide next state.
    runPromise
      .then((outcome) => this.onRunSettled(chatJid, outcome))
      .catch((err) =>
        log.error("run settled with throw (should be caught in runner)", {
          chat_jid: chatJid,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
  }

  private onRunSettled(chatJid: string, outcome: RunOutcome): void {
    const rec = this.chats.get(chatJid);
    if (!rec) return;
    const s = rec.state;

    log.debug("run settled", {
      chat_jid: chatJid,
      state: s.kind,
      aborted: outcome.aborted,
      sent_message: outcome.sentMessage,
    });

    switch (s.kind) {
      case "running":
        if (!outcome.ok && !outcome.aborted) {
          void this.fireAndForgetReact(s.trigger.seq, "❌");
        }
        if (outcome.ok && !outcome.sentMessage) {
          log.warn(
            "agent finished without calling whatsapp_send_message — Phase 4 fallback will send the final AI text",
            { chat_jid: chatJid, final_ai_text_len: outcome.finalAiText?.length ?? 0 },
          );
        }
        rec.state = { kind: "idle" };
        this.maybeReap(chatJid);
        return;

      case "aborting": {
        // Auto-restart with the pending message as the new trigger.
        const next = s.pending;
        log.info("auto-restart after hard-interrupt", {
          chat_jid: chatJid,
          old_trigger_seq: s.trigger.seq,
          new_trigger_seq: next.seq,
        });
        rec.state = this.startDebounce(chatJid, next);
        return;
      }

      case "stoppingFinal":
        // Final-stop handler will move us to idle once its own logic finishes.
        return;

      case "idle":
      case "debouncing":
        // Already moved on (rare race). Nothing to do.
        return;
    }
  }

  private fireAndForgetReact(seq: number, emoji: string): void {
    this.deps.client.react(seq, emoji).catch((err) =>
      log.debug("react failed", {
        seq,
        emoji,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private getOrCreate(chatJid: string): ChatRecord {
    let rec = this.chats.get(chatJid);
    if (!rec) {
      rec = { state: { kind: "idle" } };
      this.chats.set(chatJid, rec);
    }
    return rec;
  }

  /** When a chat goes idle, schedule its record for eviction so the Map
   *  doesn't grow unbounded for one-off groups. */
  private maybeReap(chatJid: string): void {
    const rec = this.chats.get(chatJid);
    if (!rec || rec.state.kind !== "idle") return;
    // 30s grace window: if no further activity, drop the record.
    const t = setTimeout(() => {
      const cur = this.chats.get(chatJid);
      if (cur && cur.state.kind === "idle") this.chats.delete(chatJid);
    }, 30_000);
    t.unref?.();
  }

  private shouldHandle(m: MessagePayload): boolean {
    if (m.deleted || m.tombstone) return false;
    if (m.from_me) return false;
    if (this.deps.self.pnJid && m.from.jid === this.deps.self.pnJid) return false;
    if (this.deps.self.lidJid && m.from.jid === this.deps.self.lidJid) return false;
    if (!isChatAllowed(m.chat.jid)) {
      log.debug("dropping non-whitelisted chat", {
        chat_jid: m.chat.jid,
        seq: m.seq,
      });
      return false;
    }
    // Be defensive: the bot's `chat.type` enum is "dm"|"group" per docs but
    // it has been observed to return "lid" for LID-addressed chats. Always
    // also check the JID suffix — every group JID ends in `@g.us`.
    const isGroup = m.chat.type === "group" || m.chat.jid.endsWith("@g.us");
    if (isGroup && !m.mentioned_self) {
      log.debug("dropping group msg without @mention", {
        chat_jid: m.chat.jid,
        seq: m.seq,
      });
      return false;
    }
    if (!m.text && !m.caption && !m.media) {
      log.debug("dropping message with no text/caption/media", {
        chat_jid: m.chat.jid,
        seq: m.seq,
        type: m.type,
      });
      return false;
    }
    return true;
  }

  /* ---------- shutdown ---------- */

  /** Wait for any in-flight runs to finish (best-effort, no auto-restart). */
  async drain(): Promise<void> {
    this.shuttingDown = true;
    const promises: Array<Promise<unknown>> = [];
    for (const [, rec] of this.chats) {
      const s = rec.state;
      if (s.kind === "running" || s.kind === "aborting") {
        promises.push(s.runPromise.catch(() => undefined));
      }
      if (s.kind === "debouncing") {
        clearTimeout(s.timer);
      }
    }
    await Promise.all(promises);
  }

  abortAll(): void {
    this.shuttingDown = true;
    for (const [, rec] of this.chats) {
      const s = rec.state;
      if (s.kind === "debouncing") clearTimeout(s.timer);
      if (s.kind === "running" || s.kind === "aborting" || s.kind === "stoppingFinal") {
        try {
          s.abort.abort();
        } catch {
          // ignore
        }
      }
      rec.state = { kind: "idle" };
    }
  }
}

// Re-exported for downstream readers.
export const DEBOUNCE_MS = env.JARVIS_WA_DEBOUNCE_MS;
