import { Buffer } from "node:buffer";

import {
  type AnyBackendProtocol,
  StateBackend,
  resolveBackend,
} from "deepagents";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
import type { JarvisSandbox } from "../../core/sandbox.js";
import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/send-file");

const KIND_BY_EXT: Record<string, "image" | "video" | "audio" | "document" | "sticker"> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  mov: "video",
  m4v: "video",
  mp3: "audio",
  ogg: "audio",
  oga: "audio",
  wav: "audio",
  m4a: "audio",
  flac: "audio",
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  pdf: "application/pdf",
  /** OOXML / legacy Office — needed so WA doesn't label attachments as generic BIN */
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  zip: "application/zip",
};

function detectKindAndMime(
  path: string,
  override?: { kind?: "image" | "video" | "audio" | "document" | "sticker"; mimetype?: string },
) {
  const lower = path.toLowerCase();
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  const kind = override?.kind ?? KIND_BY_EXT[ext] ?? "document";
  const mimetype = override?.mimetype ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { kind, mimetype, ext };
}

export interface CreateSendFileToolOptions {
  /** Virtual-FS backend used when there is no sandbox (state-only agents). */
  backend?: AnyBackendProtocol;
  /**
   * The agent's sandbox. When set, bytes are read with `downloadFiles`, which
   * is binary-safe — anything the agent built with `execute` (.docx, .pdf,
   * .zip, images) is sent exactly as written.
   */
  sandbox?: Pick<JarvisSandbox, "downloadFiles">;
}

export function createSendFileTool(
  client: WhatsappClient,
  options: CreateSendFileToolOptions = {},
) {
  const backend = options.backend ?? new StateBackend();
  const sandbox = options.sandbox;

  return tool(
    async (
      input: {
        path: string;
        caption?: string;
        kind?: "image" | "video" | "audio" | "document" | "sticker";
        as_voice_note?: boolean;
        quote_seq?: number;
      },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);

      let bytes: Buffer;
      try {
        if (sandbox) {
          const [file] = await sandbox.downloadFiles([input.path]);
          if (!file?.content) {
            return JSON.stringify({
              ok: false,
              error: `could not read ${input.path}: ${file?.error ?? "unknown error"}`,
            });
          }
          bytes = Buffer.from(file.content);
        } else {
          // No sandbox: files live in LangGraph state as strings.
          const resolved = await resolveBackend(backend, runtime);
          const readResult = await resolved.read(input.path);
          if (readResult.error || readResult.content == null) {
            return JSON.stringify({
              ok: false,
              error: readResult.error ?? `file not found: ${input.path}`,
            });
          }
          const raw = readResult.content;

          if (typeof raw !== "string") {
            bytes = Buffer.from(raw as Uint8Array);
          } else {
            // Heuristic: pull-file stores binaries as base64 in state. If a
            // binary-ish kind contains a valid-looking base64 blob, decode it.
            const detected = detectKindAndMime(input.path, {
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
            });
            const isLikelyBinary =
              detected.kind !== "document" || detected.mimetype !== "text/plain";
            if (isLikelyBinary && /^[A-Za-z0-9+/=\s]+$/.test(raw)) {
              bytes = Buffer.from(raw, "base64");
            } else {
              bytes = Buffer.from(raw, "utf-8");
            }
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("read failed", {
          chat_jid: ctx.chatJid,
          path: input.path,
          error: message,
        });
        return JSON.stringify({ ok: false, error: message });
      }

      const detected = detectKindAndMime(input.path, {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      });

      const filename = input.path.split("/").filter(Boolean).pop() ?? "upload.bin";
      try {
        const res = await client.sendMultipart(
          {
            to: ctx.chatJid,
            kind: detected.kind,
            file: bytes,
            filename,
            mimetype: detected.mimetype,
            ...(input.caption ? { caption: input.caption } : {}),
            ...(input.quote_seq !== undefined ? { quote_seq: input.quote_seq } : {}),
            ...(input.as_voice_note ? { ptt: true } : {}),
          },
          { signal: runtime.signal },
        );
        log.info("sent file", {
          chat_jid: ctx.chatJid,
          path: input.path,
          kind: detected.kind,
          mime: detected.mimetype,
          size_bytes: bytes.byteLength,
          seq: res.seq,
        });
        return JSON.stringify({
          ok: true,
          seq: res.seq,
          wa_message_id: res.wa_message_id,
          kind: detected.kind,
          mimetype: detected.mimetype,
          filename,
          size_bytes: bytes.byteLength,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("send-file failed", {
          chat_jid: ctx.chatJid,
          path: input.path,
          error: message,
        });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "whatsapp_send_file",
      description:
        "Send a file from your virtual filesystem to the current WhatsApp chat. Detects kind by extension (png/jpg → image, mp3/m4a → audio, mp4/mov → video, everything else → document). " +
        "Sets correct mimetype for pdf, docx/xlsx/pptx, etc. — omitting that makes WhatsApp show generic BIN. " +
        "Use `kind` to override (e.g. `kind=\"audio\"` + `as_voice_note=true` to send a voice note). Provide an absolute `path` you've already written via `write_file` or `whatsapp_pull_file`.",
      schema: z.object({
        path: z
          .string()
          .describe(
            "Absolute path to the file in your virtual FS, e.g. /home/app/wa-out/report.pdf.",
          ),
        caption: z.string().optional().describe("Optional caption (images/videos/documents)."),
        kind: z
          .enum(["image", "video", "audio", "document", "sticker"])
          .optional()
          .describe(
            "Override the auto-detected kind. Use `document` if you want the file rendered as a downloadable attachment.",
          ),
        as_voice_note: z
          .boolean()
          .optional()
          .describe("Audio only: send as a push-to-talk voice note instead of a music file."),
        quote_seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional message seq to quote-reply when sending the file."),
      }),
    },
  );
}
