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
import type { JarvisSandbox } from "../../core/sandbox.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/pull-file");

const DEFAULT_DEST_DIR = "/home/app/wa-incoming";

export function createPullFileTool(
  client: WhatsappClient,
  options: {
    /** Virtual-FS backend used when there is no sandbox. */
    backend?: AnyBackendProtocol;
    /** The agent's sandbox. When set, files are written there as raw bytes. */
    sandbox?: Pick<JarvisSandbox, "uploadFiles">;
  } = {},
) {
  const backend = options.backend ?? new StateBackend();
  const sandbox = options.sandbox;

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

      // With a sandbox, write the real bytes so `execute` tools (pdftotext,
      // python, unzip…) can open the file directly.
      if (sandbox) {
        const [upload] = await sandbox.uploadFiles([[dest, new Uint8Array(dl.bytes)]]);
        if (!upload || upload.error) {
          return JSON.stringify({
            ok: false,
            error: `could not write ${dest}: ${upload?.error ?? "unknown error"}`,
          });
        }
        const meta = {
          ok: true as const,
          seq: input.seq,
          path: dest,
          mime_type: dl.mimeType,
          size_bytes: dl.bytes.byteLength,
          encoding: "raw" as const,
        };
        log.info("pulled media", { chat_jid: ctx.chatJid, ...meta });
        return JSON.stringify(meta);
      }

      // No sandbox: the virtual FS in LangGraph state only holds strings, so
      // binaries are stored base64-encoded.
      const resolved = await resolveBackend(backend, runtime);
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
        (isText ? "" : " (stored base64-encoded).");

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
        "The file is written byte-for-byte, ready for `execute` (e.g. `pdftotext`, python). Without a sandbox, binaries are stored base64-encoded instead — the response's `encoding` field tells you which.",
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
