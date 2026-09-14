import { env } from "../../core/env.js";

/**
 * Per-chat agent sessions.
 *
 * Each chat's runs share one LangGraph thread (so the model keeps its own
 * tool results and reasoning between turns, and Anthropic's prompt cache
 * serves the whole prefix) — but only for a bounded stretch:
 *
 *   - a session ends once the chat has been idle for
 *     `JARVIS_WA_SESSION_IDLE_MIN` minutes, or after
 *     `JARVIS_WA_SESSION_MAX_RUNS` runs;
 *   - the first run of a session gets the full context block (summaries,
 *     notes, recent transcript); later runs only get the messages that
 *     arrived since the previous run.
 *
 * Without this, a chat's thread grows forever and every model call re-sends
 * all of it (hundreds of thousands of tokens) — the main cause of slow
 * replies. Long-lived memory lives in the chat summaries and notes instead.
 *
 * State is in-memory: a restart simply starts fresh sessions.
 */
export interface ChatSession {
  threadId: string;
  startedAt: number;
  lastRunAt: number;
  runs: number;
  /** Highest message seq the agent has seen in this session. */
  lastSeenSeq: number;
}

const sessions = new Map<string, ChatSession>();

export function acquireSession(
  chatJid: string,
  now = Date.now(),
): { session: ChatSession; isNew: boolean } {
  const existing = sessions.get(chatJid);
  const idleMs = env.JARVIS_WA_SESSION_IDLE_MIN * 60_000;
  if (
    existing &&
    now - existing.lastRunAt < idleMs &&
    existing.runs < env.JARVIS_WA_SESSION_MAX_RUNS
  ) {
    return { session: existing, isNew: false };
  }
  const session: ChatSession = {
    threadId: `${chatJid}#${now.toString(36)}`,
    startedAt: now,
    lastRunAt: now,
    runs: 0,
    lastSeenSeq: 0,
  };
  sessions.set(chatJid, session);
  return { session, isNew: true };
}

/** Record a finished run. Failed runs end the session so the next starts clean. */
export function completeSessionRun(
  chatJid: string,
  session: ChatSession,
  result: { ok: boolean; lastSeenSeq: number },
): void {
  if (sessions.get(chatJid) !== session) return;
  if (!result.ok) {
    sessions.delete(chatJid);
    return;
  }
  session.runs += 1;
  session.lastRunAt = Date.now();
  session.lastSeenSeq = Math.max(session.lastSeenSeq, result.lastSeenSeq);
}
