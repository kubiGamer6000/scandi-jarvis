import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/send-message");

export function createSendMessageTool(client: WhatsappClient) {
  return tool(
    async (
      input: { text: string; quote_seq?: number; mentions?: string[] },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
      const { text, quote_seq, mentions } = input;
      try {
        const res = await client.send(
          {
            to: ctx.chatJid,
            text,
            ...(quote_seq !== undefined ? { quote_seq } : {}),
            ...(mentions && mentions.length > 0 ? { mentions } : {}),
          },
          { signal: runtime.signal },
        );
        log.info("sent message", {
          chat_jid: ctx.chatJid,
          seq: res.seq,
          quote_seq,
          chars: text.length,
        });
        return JSON.stringify({
          ok: true,
          seq: res.seq,
          wa_message_id: res.wa_message_id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("send failed", { chat_jid: ctx.chatJid, error: message });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "whatsapp_send_message",
      description:
        "Send a plain-text WhatsApp message to the current chat. This is the ONLY way you can talk to the user — your AIMessage text is internal and never shown to them. " +
        "Send 1-N times per turn. Keep messages short (a phone screen of text). Use `quote_seq` to reply to a specific message; use `mentions` (array of JIDs) sparingly in groups.",
      schema: z.object({
        text: z
          .string()
          .min(1)
          .max(4096)
          .describe("The message body. Markdown is not rendered; line breaks are."),
        quote_seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional public `seq` of the message you're replying to. Use when context isn't obvious or when answering a specific question in a busy thread.",
          ),
        mentions: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of JIDs to @-mention. Include the same JID in the `text` as `@<digits>` for the WhatsApp client to render the mention. Groups only.",
          ),
      }),
    },
  );
}
