import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/get-message");

export function createGetMessageTool(client: WhatsappClient) {
  return tool(
    async (
      input: { seq: number },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
      try {
        const m = await client.getMessage(input.seq, { signal: runtime.signal });
        log.debug("got message", { chat_jid: ctx.chatJid, seq: input.seq });
        // Return a compact JSON shape — drop the bulky raw envelope we don't
        // need at the LLM layer.
        return JSON.stringify({
          ok: true,
          seq: m.seq,
          wa_id: m.wa_id,
          chat: m.chat,
          from: m.from,
          from_me: m.from_me,
          timestamp: m.timestamp,
          type: m.type,
          text: m.text,
          caption: m.caption ?? null,
          mentioned_self: m.mentioned_self,
          mentioned_jids: m.mentioned_jids ?? [],
          quoted: m.quoted ?? null,
          media: m.media
            ? {
                media_type: m.media.media_type,
                mime_type: m.media.mime_type,
                size_bytes: m.media.size_bytes,
                file_name: m.media.file_name ?? null,
                caption: m.media.caption ?? null,
                download_status: m.media.download_status,
                processed: m.media.processed
                  ? {
                      text: m.media.processed.text,
                      processor: m.media.processed.processor,
                    }
                  : null,
              }
            : null,
          reactions: m.reactions ?? [],
          edit_count: m.edit_count ?? 0,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("get-message failed", {
          chat_jid: ctx.chatJid,
          seq: input.seq,
          error: message,
        });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "whatsapp_get_message",
      description:
        "Look up a single message by `seq` from the current chat. Returns sender, body, quoted-reply target, media info (with AI-summary if available), and reactions. " +
        "Useful when you need to inspect a specific message in detail (e.g. examine media metadata before pulling it).",
      schema: z.object({
        seq: z.number().int().positive().describe("Public seq of the message."),
      }),
    },
  );
}
