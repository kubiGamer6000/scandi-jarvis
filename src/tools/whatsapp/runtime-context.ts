import { z } from "zod";

/**
 * Shape of the LangGraph `runtime.context` we plumb in from the WhatsApp
 * dispatcher into every tool call. Each tool reads `chatJid` (the conversation
 * the run belongs to) and the optional `triggeringSeq` (so e.g. `react`
 * defaults to that message when the agent doesn't pass one).
 *
 * The dispatcher constructs this exactly once per `agent.invoke` and never
 * mutates it; the agent (and any subagents) read it through `runtime.context`.
 */
export const WhatsappContextSchema = z
  .object({
    /** Canonical JID for the chat. Used as both `thread_id` and as `to`. */
    chatJid: z.string().min(1),
    /** "dm" | "group". Cheap discriminator for prompt-side decisions. */
    chatType: z.enum(["dm", "group"]),
    /** Public seq of the message that triggered this run. Optional only because
     *  cron-style runs (e.g. summary refresh) don't have one. */
    triggeringSeq: z.number().int().positive().optional(),
    /** Stable id for the linked WA account (for tagging + multi-account-future). */
    accountId: z.string().min(1).optional(),
    /** PN JID of the bot itself. Tools use this to avoid mentioning the bot. */
    selfPnJid: z.string().optional(),
    /** LID JID of the bot itself. */
    selfLidJid: z.string().optional(),
  })
  // DeepAgents' built-in middleware (e.g. anthropicPromptCachingMiddleware)
  // reads its own keys (`enableCaching`, `ttl`, etc.) off `runtime.context`.
  // Use `.passthrough()` so those keys survive Zod validation when we add
  // them to the invoke context (instead of being stripped silently).
  .passthrough();

export type WhatsappContext = z.infer<typeof WhatsappContextSchema>;

/**
 * Pull `WhatsappContext` out of a tool runtime, with a typed error if the
 * context is missing — which would mean the tool ran from a non-WhatsApp
 * frontend (e.g. CLI). We treat that as a programming error and fail loudly.
 */
export function readWhatsappContext(
  runtime: { context: unknown } | undefined,
): WhatsappContext {
  const raw = runtime?.context;
  const parsed = WhatsappContextSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "WhatsApp tool called outside a WhatsApp run (runtime.context missing or " +
        "invalid). Did you wire `contextSchema` and `context` into agent.invoke?",
    );
  }
  return parsed.data;
}
