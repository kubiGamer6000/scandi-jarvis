import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/edit-message");

export function createEditMessageTool(client: WhatsappClient) {
  return tool(
    async (
      input: { seq: number; text: string },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
      try {
        const res = await client.edit(input.seq, input.text, {
          signal: runtime.signal,
        });
        log.info("edited message", {
          chat_jid: ctx.chatJid,
          seq: input.seq,
          chars: input.text.length,
        });
        return JSON.stringify({
          ok: true,
          seq: res.seq,
          edit_wa_message_id: res.edit_wa_message_id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("edit failed", {
          chat_jid: ctx.chatJid,
          seq: input.seq,
          error: message,
        });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "whatsapp_edit_message",
      description:
        "Edit one of YOUR OWN recent WhatsApp messages. Use ONLY to correct a factual error or fix a typo in a message you sent within the last 15 minutes — don't use this to keep \"streaming\" updates (just send a new message). " +
        "WhatsApp rejects edits to messages older than ~15min and to messages you didn't send.",
      schema: z.object({
        seq: z
          .number()
          .int()
          .positive()
          .describe("Public seq of the message you sent that you want to edit."),
        text: z
          .string()
          .min(1)
          .max(4096)
          .describe("Replacement text for the message."),
      }),
    },
  );
}
