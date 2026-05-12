import { Buffer } from "node:buffer";

import {
  type AnyBackendProtocol,
  type ReadRawResult,
  type ReadResult,
  StateBackend,
  resolveBackend,
} from "deepagents";
import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";
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

/**
 * Extensions where string content must round-trip as real binary (ZIP/PDF/images).
 * If the virtual FS held UTF-8 text (e.g. from write_file pasting read_file output),
 * bytes get U+FFFD or line-number junk — Word reports the file corrupt.
 */
const STRICT_BINARY_EXT = new Set([
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "pdf",
  "zip",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);

function utf8ReplacementCount(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) {
      n++;
      i += 2;
    }
  }
  return n;
}

function validateBinaryMagic(ext: string, buf: Buffer): boolean {
  const e = ext.toLowerCase();
  if (buf.length < 4) return false;
  switch (e) {
    case "docx":
    case "xlsx":
    case "pptx":
    case "zip":
      return buf[0] === 0x50 && buf[1] === 0x4b;
    case "pdf":
      return buf.subarray(0, 4).equals(Buffer.from("%PDF"));
    case "doc":
    case "xls":
    case "ppt": {
      const ole =
        buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
      return ole || (buf[0] === 0x50 && buf[1] === 0x4b);
    }
    case "png":
      return (
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      );
    case "jpg":
    case "jpeg":
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case "gif":
      return (
        buf.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
        buf.subarray(0, 6).equals(Buffer.from("GIF89a"))
      );
    case "webp":
      return buf.length >= 12 && buf.subarray(8, 12).equals(Buffer.from("WEBP"));
    default:
      return true;
  }
}

function bytesForUpload(
  raw: string | Uint8Array,
  ext: string,
): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  const strict = STRICT_BINARY_EXT.has(ext.toLowerCase());

  if (typeof raw !== "string") {
    const bytes = Buffer.from(raw as Uint8Array);
    if (strict && !validateBinaryMagic(ext, bytes)) {
      return {
        ok: false,
        error: `Bytes on disk do not look like a valid .${ext} (wrong file signature). Rebuild the file in the sandbox; do not paste tool output into write_file.`,
      };
    }
    return { ok: true, bytes };
  }

  const text = raw;

  if (!strict) {
    const e = ext.toLowerCase();
    const mime = MIME_BY_EXT[e] ?? "";
    const isPlain =
      mime.startsWith("text/") ||
      e === "txt" ||
      e === "md" ||
      e === "csv" ||
      e === "json" ||
      e === "html" ||
      e === "htm";
    if (isPlain) {
      return { ok: true, bytes: Buffer.from(text, "utf-8") };
    }
    const isLikelyBinary = e in KIND_BY_EXT || (mime.length > 0 && !mime.startsWith("text/"));
    if (isLikelyBinary && /^[A-Za-z0-9+/=\s]+$/.test(text)) {
      try {
        return { ok: true, bytes: Buffer.from(text, "base64") };
      } catch {
        return { ok: true, bytes: Buffer.from(text, "utf-8") };
      }
    }
    return { ok: true, bytes: Buffer.from(text, "utf-8") };
  }

  // Strict: prefer base64 (whatsapp_pull_file), then verify magic. Never accept mojibake UTF-8.
  const compact = text.replace(/\s/g, "");
  if (
    compact.length >= 16 &&
    /^[A-Za-z0-9+/]+=*$/.test(compact) &&
    compact.length % 4 !== 1
  ) {
    const fromB64 = Buffer.from(compact, "base64");
    if (validateBinaryMagic(ext, fromB64)) {
      return { ok: true, bytes: fromB64 };
    }
  }

  const asUtf8 = Buffer.from(text, "utf-8");
  const replacements = utf8ReplacementCount(asUtf8);
  if (replacements > 40 || (asUtf8.length > 0 && replacements / asUtf8.length > 0.003)) {
    return {
      ok: false,
      error:
        "File looks like binary that was stored as UTF-8 text (many U+FFFD replacement bytes). " +
        "Regenerate: run docx-js / pack.py / Packer in `execute` so the .docx lives as real bytes on disk, or use whatsapp_pull_file (base64). " +
        "Never copy read_file / tool transcripts into write_file for .docx.",
    };
  }

  if (validateBinaryMagic(ext, asUtf8)) {
    return { ok: true, bytes: asUtf8 };
  }

  return {
    ok: false,
    error: `Not a valid .${ext} after read (missing ZIP/PDF/image signature). ` +
      "If the path is from write_file, the model probably injected text line numbers or re-encoded OXML — rebuild only via sandbox scripts writing bytes.",
  };
}

/**
 * DeepAgents `read()` line-paginates and may decode binary as UTF-8 (U+FFFD).
 * `readRaw()` returns {@link FileData} with `Uint8Array` for true binary — required for .docx from the sandbox.
 */
type BackendWithReadRaw = AnyBackendProtocol & {
  readRaw?: (filePath: string) => Promise<{
    error?: string;
    data?: { content?: string | Uint8Array | string[]; mimeType?: string };
  }>;
};

async function readPayloadForSend(
  resolved: AnyBackendProtocol,
  filePath: string,
  ext: string,
): Promise<{ ok: true; raw: string | Uint8Array } | { ok: false; error: string }> {
  const needRawBytes = STRICT_BINARY_EXT.has(ext.toLowerCase());
  const withRaw = resolved as BackendWithReadRaw;

  if (needRawBytes && typeof withRaw.readRaw === "function") {
    try {
      const rawRes = (await withRaw.readRaw(filePath)) as ReadRawResult;
      if (!rawRes.error && rawRes.data != null) {
        const data = rawRes.data;
        const c =
          "mimeType" in data && "content" in data && !Array.isArray(data.content)
            ? (data as { content: string | Uint8Array }).content
            : null;
        if (c instanceof Uint8Array) {
          log.debug("send-file using readRaw (binary)", {
            path: filePath,
            byteLength: c.byteLength,
          });
          return { ok: true, raw: c };
        }
        if (typeof c === "string") {
          return { ok: true, raw: c };
        }
      }
    } catch (err) {
      log.warn("readRaw failed, falling back to read()", {
        path: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const readOut = (await resolved.read(filePath)) as ReadResult | string;
  if (typeof readOut === "string") {
    return { ok: true, raw: readOut };
  }
  const readResult = readOut;
  if (readResult.error || readResult.content == null) {
    return {
      ok: false,
      error: readResult.error ?? `file not found: ${filePath}`,
    };
  }
  return { ok: true, raw: readResult.content };
}

export function createSendFileTool(
  client: WhatsappClient,
  options: { backend?: AnyBackendProtocol } = {},
) {
  const backend = options.backend ?? new StateBackend();

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
      const resolved = await resolveBackend(backend, runtime);

      // Read the bytes back. The backend.readRaw signature returns
      // { content?: string; encoding?: 'utf-8'|'base64' } in the agent's
      // virtual FS. For state backend, content is plain string; we treat the
      // result generically.
      let bytes: Buffer;
      try {
        const detectedPath = detectKindAndMime(input.path, {
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
        });
        const payload = await readPayloadForSend(
          resolved,
          input.path,
          detectedPath.ext,
        );
        if (!payload.ok) {
          return JSON.stringify({ ok: false, error: payload.error });
        }
        const decoded = bytesForUpload(payload.raw, detectedPath.ext);
        if (!decoded.ok) {
          return JSON.stringify({ ok: false, error: decoded.error });
        }
        bytes = decoded.bytes;
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
        "For Office/ZIP/PDF/images, reads binary via backend readRaw when available (sandbox-safe). " +
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
