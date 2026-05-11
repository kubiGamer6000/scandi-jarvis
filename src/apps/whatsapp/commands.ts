/**
 * Pure parsers for "slash"-style commands the operator can send to control
 * Jarvis from inside WhatsApp.
 *
 * These are detected by the dispatcher BEFORE the agent runs and never reach
 * the LLM. Adding a new command is just adding a branch here + handling it
 * in the dispatcher.
 *
 * Conventions:
 *   - case-insensitive
 *   - allows an @-mention prefix ("@jarvis /stop") or the bare slash form
 *   - allows optional surrounding whitespace
 *
 * v1 implements only `/stop`. `/jarvis on|off` is planned but a SQL-only
 * operation today (see jarvis.chat_context.enabled).
 */

export type ParsedCommand = { kind: "stop" } | { kind: "none" };

const STOP_PATTERN = /^\s*(?:@\S+\s+)?\/(?:stop|halt|cancel)\s*$/i;

/**
 * Returns the command embedded in the message text, or `{ kind: "none" }`
 * if it's a regular conversational message.
 *
 * NB: we only check `text`. If users want commands in captions, we can
 * extend this to look at both — but commands in captions are weird UX.
 */
export function parseCommand(text: string | null | undefined): ParsedCommand {
  if (!text) return { kind: "none" };
  if (STOP_PATTERN.test(text)) return { kind: "stop" };
  return { kind: "none" };
}
