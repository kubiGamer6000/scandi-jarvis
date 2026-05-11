import { Buffer } from "node:buffer";

import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import type {
  EditResponse,
  FetchMessagesParams,
  FetchMessagesResponse,
  HealthResponse,
  MediaInspectResponse,
  MeResponse,
  MessagePayload,
  SendRequest,
  SendResponse,
} from "./types.js";

const log = createLogger("apps/whatsapp/client");

/**
 * Thin typed REST client for the scandi-wa-bot HTTP API.
 *
 * Single bearer token, single account, single base URL — matches the bot's
 * single-tenant deployment. Construct once with `createWhatsappClient()` at
 * app boot and pass through to tools / dispatcher.
 */
export interface WhatsappClient {
  /** GET /v1/health (no auth required). Useful for preflight + readiness. */
  health(): Promise<HealthResponse>;
  /** GET /v1/me — the bot's identity (pn_jid, lid_jid, push_name). */
  me(): Promise<MeResponse>;
  /** GET /v1/messages/:seq */
  getMessage(seq: number, opts?: RequestOpts): Promise<MessagePayload>;
  /** GET /v1/messages/:seq/media */
  getMedia(seq: number, opts?: RequestOpts): Promise<MediaInspectResponse>;
  /**
   * GET /v1/messages/:seq/media/download?proxy=true
   *
   * Streams the bytes through the bot rather than via the Firebase token URL
   * — keeps everything on a single auth path and works behind firewalls.
   * Returns the buffer plus the mime + filename headers the bot set.
   */
  downloadMedia(
    seq: number,
    opts?: RequestOpts,
  ): Promise<{ bytes: Buffer; mimeType: string; fileName: string | null }>;
  /** GET /v1/chats/:jid/messages */
  fetchMessages(
    chatJid: string,
    params?: FetchMessagesParams,
    opts?: RequestOpts,
  ): Promise<FetchMessagesResponse>;
  /** POST /v1/send (text + optional media via url/base64). */
  send(body: SendRequest, opts?: RequestOpts): Promise<SendResponse>;
  /**
   * POST /v1/send/multipart — preferred for raw bytes (no base64 overhead).
   * `file` is a Buffer/Uint8Array; the rest mirrors the JSON `send` shape.
   */
  sendMultipart(
    args: {
      to: string;
      kind: "image" | "video" | "audio" | "document" | "sticker";
      file: Uint8Array | Buffer;
      filename?: string;
      mimetype?: string;
      caption?: string;
      mentions?: string[];
      quote_seq?: number;
      gif_playback?: boolean;
      ptt?: boolean;
    },
    opts?: RequestOpts,
  ): Promise<SendResponse>;
  /** POST /v1/messages/:seq/react */
  react(seq: number, emoji: string, opts?: RequestOpts): Promise<void>;
  /** POST /v1/messages/:seq/edit — requires from_me=true on the target. */
  edit(seq: number, text: string, opts?: RequestOpts): Promise<EditResponse>;
}

export interface RequestOpts {
  signal?: AbortSignal;
}

export interface WhatsappClientConfig {
  baseUrl: string;
  token: string;
  /** Default request timeout per call (ms). 30s is plenty for the WA bot. */
  timeoutMs?: number;
}

class WhatsappHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly endpoint: string,
    message: string,
  ) {
    super(`WhatsappClient ${endpoint} → ${status}${code ? ` (${code})` : ""}: ${message}`);
    this.name = "WhatsappHttpError";
  }
}

export { WhatsappHttpError };

export function createWhatsappClient(
  config?: Partial<WhatsappClientConfig>,
): WhatsappClient {
  const baseUrl = (config?.baseUrl ?? env.WA_BOT_BASE_URL ?? "").replace(/\/$/, "");
  const token = config?.token ?? env.WA_BOT_TOKEN ?? "";
  const timeoutMs = config?.timeoutMs ?? 30_000;

  if (!baseUrl) {
    throw new Error("WA_BOT_BASE_URL is not set");
  }
  if (!token) {
    throw new Error("WA_BOT_TOKEN is not set");
  }

  async function call<T>(
    method: string,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
      multipart?: FormData;
      auth?: boolean;
      signal?: AbortSignal;
      parse?: "json" | "void" | "buffer-with-headers";
    } = {},
  ): Promise<T> {
    const search = init.query
      ? "?" +
        Object.entries(init.query)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          )
          .join("&")
      : "";
    const url = `${baseUrl}${path}${search}`;

    const ourCtl = new AbortController();
    const timer = setTimeout(() => ourCtl.abort(new Error("request timeout")), timeoutMs);
    const signal = init.signal
      ? anySignal([init.signal, ourCtl.signal])
      : ourCtl.signal;

    const headers: Record<string, string> = {};
    if (init.auth !== false) {
      headers.authorization = `Bearer ${token}`;
    }

    let body: string | FormData | undefined;
    if (init.multipart) {
      body = init.multipart;
      // fetch will set the multipart boundary itself; don't override.
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let text = "";
      let code: string | undefined;
      try {
        const errJson = (await res.json()) as { code?: string; message?: string };
        code = errJson.code;
        text = errJson.message ?? "";
      } catch {
        text = await res.text().catch(() => "");
      }
      throw new WhatsappHttpError(res.status, code, `${method} ${path}`, text || res.statusText);
    }

    const mode = init.parse ?? "json";
    if (mode === "void") {
      // drain in case the server sent any body
      await res.arrayBuffer().catch(() => undefined);
      return undefined as unknown as T;
    }
    if (mode === "buffer-with-headers") {
      const buf = Buffer.from(await res.arrayBuffer());
      const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
      const disposition = res.headers.get("content-disposition");
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const fileName = match?.[1] ?? null;
      return { bytes: buf, mimeType, fileName } as unknown as T;
    }
    return (await res.json()) as T;
  }

  return {
    health(): Promise<HealthResponse> {
      return call<HealthResponse>("GET", "/v1/health", { auth: false });
    },
    me(): Promise<MeResponse> {
      return call<MeResponse>("GET", "/v1/me");
    },
    getMessage(seq, opts) {
      return call<MessagePayload>("GET", `/v1/messages/${seq}`, {
        signal: opts?.signal,
      });
    },
    getMedia(seq, opts) {
      return call<MediaInspectResponse>("GET", `/v1/messages/${seq}/media`, {
        signal: opts?.signal,
      });
    },
    downloadMedia(seq, opts) {
      return call<{ bytes: Buffer; mimeType: string; fileName: string | null }>(
        "GET",
        `/v1/messages/${seq}/media/download`,
        {
          query: { proxy: true },
          parse: "buffer-with-headers",
          signal: opts?.signal,
        },
      );
    },
    fetchMessages(chatJid, params, opts) {
      return call<FetchMessagesResponse>(
        "GET",
        `/v1/chats/${encodeURIComponent(chatJid)}/messages`,
        {
          query: {
            before_seq: params?.before_seq,
            after_seq: params?.after_seq,
            limit: params?.limit,
            include_media: params?.include_media,
            include_reactions: params?.include_reactions,
            include_tombstones: params?.include_tombstones,
          },
          signal: opts?.signal,
        },
      );
    },
    send(body, opts) {
      return call<SendResponse>("POST", "/v1/send", {
        body,
        signal: opts?.signal,
      });
    },
    async sendMultipart(args, opts) {
      const form = new FormData();
      form.set("to", args.to);
      form.set("kind", args.kind);
      // Wrap the bytes in a Blob so undici/fetch attaches it correctly.
      const blob = new Blob([new Uint8Array(args.file)], {
        type: args.mimetype ?? "application/octet-stream",
      });
      form.set("file", blob, args.filename ?? "upload.bin");
      if (args.caption) form.set("caption", args.caption);
      if (args.mimetype) form.set("mimetype", args.mimetype);
      if (args.filename) form.set("filename", args.filename);
      if (args.mentions && args.mentions.length > 0) {
        form.set("mentions", args.mentions.join(","));
      }
      if (args.quote_seq !== undefined) {
        form.set("quote_seq", String(args.quote_seq));
      }
      if (args.gif_playback !== undefined) {
        form.set("gif_playback", String(args.gif_playback));
      }
      if (args.ptt !== undefined) {
        form.set("ptt", String(args.ptt));
      }
      return call<SendResponse>("POST", "/v1/send/multipart", {
        multipart: form,
        signal: opts?.signal,
      });
    },
    async react(seq, emoji, opts) {
      await call<void>("POST", `/v1/messages/${seq}/react`, {
        body: { emoji },
        parse: "void",
        signal: opts?.signal,
      });
    },
    edit(seq, text, opts) {
      return call<EditResponse>("POST", `/v1/messages/${seq}/edit`, {
        body: { text },
        signal: opts?.signal,
      });
    },
  };
}

/**
 * Tiny `AbortSignal.any`-style polyfill (Node 20 ships AbortSignal.any in
 * 20.3+, but we're conservative and avoid relying on it). Aborts when any
 * source signal aborts.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      return ctl.signal;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

// Useful for unit tests that want to log every call.
export function debugLog(client: WhatsappClient): WhatsappClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      return async (...args: unknown[]) => {
        const t0 = Date.now();
        try {
          const out = await (orig as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
          log.debug(`${String(prop)} OK`, { ms: Date.now() - t0 });
          return out;
        } catch (err) {
          log.warn(`${String(prop)} FAILED`, {
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      };
    },
  });
}
