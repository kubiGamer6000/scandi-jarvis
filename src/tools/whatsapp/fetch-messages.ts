import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";
import { formatMessageLine } from "../../apps/whatsapp/transcript.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/fetch-messages");

export function createFetchMessagesTool(client: WhatsappClient) {
  return tool(
    async (
      input: {
        chat_jid?: string;
        before_seq?: number;
        after_seq?: number;
        limit?: number;
        include_media?: boolean;
      },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
      const target = input.chat_jid ?? ctx.chatJid;
      const limit = Math.min(input.limit ?? 50, 200);
      try {
        const res = await client.fetchMessages(
          target,
          {
            ...(input.before_seq !== undefined ? { before_seq: input.before_seq } : {}),
            ...(input.after_seq !== undefined ? { after_seq: input.after_seq } : {}),
            limit,
            include_media: input.include_media ?? true,
            include_reactions: true,
          },
          { signal: runtime.signal },
        );
        const lines = res.messages.map((m) => formatMessageLine(m));
        const transcript = lines.join("\n");
        log.debug("fetched", { chat_jid: target, count: res.count });
        return JSON.stringify({
          ok: true,
          chat_jid: res.chat_jid,
          count: res.count,
          ascending: res.ascending,
          next_before_seq: res.next_before_seq,
          next_after_seq: res.next_after_seq,
          transcript,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("fetch failed", { chat_jid: target, error: message });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "whatsapp_fetch_messages",
      description:
        "Fetch a chunk of message history (formatted as a transcript with `[seq=N] sender: text` lines). " +
        "Defaults to the current chat; pass `chat_jid` to look at another chat. Use `before_seq` to page backwards through history (older messages) and `after_seq` for newer. Use this when the user references something earlier that isn't in your context block.",
      schema: z.object({
        chat_jid: z
          .string()
          .optional()
          .describe("Chat JID to query. Defaults to the current chat."),
        before_seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return messages with seq < this. Pair with `limit` to page backwards."),
        after_seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return messages with seq > this."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return. Default 50, hard cap 100 (the WA bot's max)."),
        include_media: z
          .boolean()
          .optional()
          .describe("Include media (with AI-summary text) in the transcript. Default true."),
      }),
    },
  );
}
