import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/react");

export function createReactTool(client: WhatsappClient) {
  return tool(
    async (
      input: { emoji: string; seq?: number },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
      const seq = input.seq ?? ctx.triggeringSeq;
      if (seq === undefined) {
        return JSON.stringify({
          ok: false,
          error: "no seq given and no triggeringSeq in runtime",
        });
      }
      try {
        await client.react(seq, input.emoji, { signal: runtime.signal });
        log.debug("reacted", {
          chat_jid: ctx.chatJid,
          seq,
          emoji: input.emoji || "<cleared>",
        });
        return JSON.stringify({ ok: true, seq, emoji: input.emoji });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("react failed", { chat_jid: ctx.chatJid, seq, error: message });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "whatsapp_react",
      description:
        "React to a message with a single emoji. Pass `seq=` to target a specific message; omit to react to the message that triggered this run. Pass `emoji=\"\"` (empty string) to clear an existing reaction. " +
        "Use reactions as lightweight status: 👀 ack on a heavy task, ⏳ working, ✅ done, ❌ failed, ❓ confused.",
      schema: z.object({
        emoji: z
          .string()
          .max(8)
          .describe(
            "Single emoji to set, or empty string to remove your previous reaction.",
          ),
        seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional message seq to react to. Defaults to the message that triggered this run.",
          ),
      }),
    },
  );
}
