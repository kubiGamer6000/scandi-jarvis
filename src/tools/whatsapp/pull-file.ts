import { Command } from "@langchain/langgraph";
import {
  type AnyBackendProtocol,
  StateBackend,
  resolveBackend,
} from "deepagents";
import { tool, type ToolRuntime } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/pull-file");

const DEFAULT_DEST_DIR = "/home/app/wa-incoming";

export function createPullFileTool(
  client: WhatsappClient,
  options: { backend?: AnyBackendProtocol } = {},
) {
  const backend = options.backend ?? new StateBackend();

  return tool(
    async (
      input: { seq: number; dest_path?: string },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);

      let dl: { bytes: Buffer; mimeType: string; fileName: string | null };
      try {
        dl = await client.downloadMedia(input.seq, { signal: runtime.signal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("downloadMedia failed", {
          chat_jid: ctx.chatJid,
          seq: input.seq,
          error: message,
        });
        return JSON.stringify({ ok: false, error: message });
      }

      const filename =
        input.dest_path?.split("/").filter(Boolean).pop() ??
        dl.fileName ??
        `wa-${input.seq}.bin`;
      const dest = input.dest_path ?? `${DEFAULT_DEST_DIR}/${filename}`;

      const resolved = await resolveBackend(backend, runtime);

      // The agent's virtual FS expects string content. Encode bytes as base64
      // when they're not safely UTF-8 (anything with NUL or non-UTF-8 sequences).
      // For most documents we can store the raw decoded UTF-8 (PDFs are binary
      // — we keep them as base64). The agent reads base64 back via decode tools
      // or shell commands in the sandbox.
      const isText =
        dl.mimeType.startsWith("text/") || dl.mimeType.includes("json");
      const content = isText
        ? dl.bytes.toString("utf-8")
        : dl.bytes.toString("base64");

      const result = await resolved.write(dest, content);
      if (result.error) {
        return JSON.stringify({ ok: false, error: result.error });
      }

      const meta = {
        ok: true as const,
        seq: input.seq,
        path: dest,
        mime_type: dl.mimeType,
        size_bytes: dl.bytes.byteLength,
        encoding: isText ? ("utf-8" as const) : ("base64" as const),
      };

      log.info("pulled media", {
        chat_jid: ctx.chatJid,
        ...meta,
      });

      const summary =
        `Pulled message ${input.seq} (${dl.mimeType}, ${dl.bytes.byteLength} bytes) → ${dest}` +
        (isText
          ? ""
          : " (stored base64-encoded; use `execute base64 -d ...` in the sandbox or have a tool decode it).");

      const message = new ToolMessage({
        content: JSON.stringify(meta),
        tool_call_id: runtime.toolCall?.id ?? runtime.toolCallId,
        name: "whatsapp_pull_file",
        additional_kwargs: { summary },
      });

      if (result.filesUpdate) {
        return new Command({
          update: { files: result.filesUpdate, messages: [message] },
        });
      }
      return message;
    },
    {
      name: "whatsapp_pull_file",
      description:
        "Download media (image, document, audio, video) attached to a WhatsApp message and write it into your virtual filesystem so you can `read_file` or `execute` against it. " +
        "Pass `seq` of the message that carries the attachment; optionally pass `dest_path` (absolute, e.g. /home/app/uploads/spec.pdf) — otherwise the file lands in /home/app/wa-incoming/<filename>. " +
        "Binary files (PDFs, images, etc.) are stored base64-encoded; the response tells you. Text-ish files are stored as UTF-8.",
      schema: z.object({
        seq: z
          .number()
          .int()
          .positive()
          .describe("Seq of the WhatsApp message carrying the media to download."),
        dest_path: z
          .string()
          .optional()
          .describe(
            "Optional absolute path to write to (e.g. /home/app/uploads/spec.pdf). Default: /home/app/wa-incoming/<original-filename>.",
          ),
      }),
    },
  );
}
