/**
 * Type definitions mirroring scandi-wa-bot's HTTP API payloads.
 *
 * Source of truth: `docs/API.md` in scandi-wa-bot. We only model what we
 * actually consume; unknown fields are tolerated (the bot may add fields).
 */

/**
 * The documented values from scandi-wa-bot are `"dm"` and `"group"`. In
 * practice the bot has been observed to also return `"lid"` for chats
 * addressed via a LID (LID-mode DMs). We accept anything (string) and
 * narrow it at the boundary via `normaliseChatType()` below — that keeps
 * runtime crashes off the table when the bot adds new values.
 */
export type ChatType = "dm" | "group" | (string & {});

/**
 * Coerce the bot's `chat.type` (or `undefined`) into a canonical
 * `"dm" | "group"`. Rules (in order):
 *   1. JIDs ending in `@g.us` are always groups (most reliable signal).
 *   2. Otherwise, if the bot says `"group"` literally, trust it.
 *   3. Everything else (DM, LID-mode DM, unknown) → `"dm"`.
 */
export function normaliseChatType(
  raw: ChatType | string | null | undefined,
  jid: string,
): "dm" | "group" {
  if (jid.endsWith("@g.us")) return "group";
  if (raw === "group") return "group";
  return "dm";
}
export type AddressingMode = "pn" | "lid" | null;

export type MediaKind =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "gif"
  | "ptv";

export type MediaDownloadStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed";

export interface ProcessedMedia {
  text: string | null;
  processor: string | null;
  model: string | null;
  completed_at: string | null;
}

export interface MessageMedia {
  media_type: MediaKind | string;
  mime_type: string | null;
  size_bytes: number | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  page_count?: number | null;
  file_name?: string | null;
  caption?: string | null;
  is_voice_note?: boolean | null;
  download_status: MediaDownloadStatus;
  url?: string | null;
  processed?: ProcessedMedia | null;
}

export interface MessageQuoted {
  seq: number | null;
  message_id: string | null;
  from_jid: string | null;
  text: string | null;
}

export interface MessageReaction {
  emoji: string | null;
  actor_jid: string;
  at: string;
}

export interface MessageFrom {
  jid: string;
  pn?: string | null;
  lid?: string | null;
  push_name?: string | null;
}

export interface MessageChat {
  jid: string;
  type: ChatType;
  subject?: string | null;
  participant_count?: number | null;
}

/**
 * The canonical message payload as returned by:
 *   - GET /v1/messages/:seq
 *   - GET /v1/chats/:jid/messages (messages[])
 *   - webhooks (.message)
 */
export interface MessagePayload {
  seq: number;
  wa_id: string;
  chat: MessageChat;
  from: MessageFrom;
  from_me: boolean;
  timestamp: string;
  type: string | null;
  text: string | null;
  caption?: string | null;
  mentioned_self: boolean;
  mentioned_jids?: string[];
  addressing_mode?: AddressingMode;
  forwarded?: boolean | null;
  forward_score?: number | null;
  edit_count?: number;
  last_edited_at?: string | null;
  deleted?: boolean;
  deleted_at?: string | null;
  deleted_by_jid?: string | null;
  deletion_reason?: string | null;
  tombstone?: boolean;
  quoted?: MessageQuoted | null;
  media?: MessageMedia | null;
  reactions?: MessageReaction[];
}

export type WebhookEvent =
  | "message.received"
  | "message.edited"
  | "message.deleted"
  | "message.reacted"
  | "message.processed"
  | "webhook.test";

export interface WebhookAccount {
  id: string;
  pn?: string | null;
  lid?: string | null;
}

export interface WebhookEnvelope {
  event: WebhookEvent;
  created_at: string;
  account: WebhookAccount;
  message: MessagePayload | null;
  reaction?: { actor_jid: string; emoji: string | null };
  test?: { source: string };
}

/* ---------- request / response shapes for the actions we issue ---------- */

export interface SendMediaInput {
  kind: MediaKind;
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  gif_playback?: boolean;
  ptt?: boolean;
  seconds?: number;
}

export interface SendRequest {
  to: string;
  text?: string;
  media?: SendMediaInput;
  quote_seq?: number;
  mentions?: string[];
}

export interface SendResponse {
  seq: number | null;
  wa_message_id: string;
  to: string;
  type: string;
}

export interface ReactRequest {
  emoji: string;
}

export interface EditRequest {
  text: string;
}

export interface EditResponse {
  seq: number;
  wa_message_id: string;
  edit_wa_message_id: string;
}

export interface FetchMessagesParams {
  before_seq?: number;
  after_seq?: number;
  limit?: number;
  include_media?: boolean;
  include_reactions?: boolean;
  include_tombstones?: boolean;
}

export interface FetchMessagesResponse {
  chat_jid: string;
  count: number;
  ascending: boolean;
  next_before_seq: number | null;
  next_after_seq: number | null;
  messages: MessagePayload[];
}

export interface HealthResponse {
  status: string;
  sock_connected: boolean;
  account_label: string | null;
  last_event_at: string | null;
  initial_sync_done: boolean;
  account_status: string;
}

export interface MeResponse {
  account_id: string;
  account_label: string | null;
  pn_jid: string | null;
  lid_jid: string | null;
  push_name: string | null;
  status: string;
}

export interface MediaInspectResponse {
  seq: number;
  wa_message_id: string;
  chat_jid: string;
  media: MessageMedia;
  processed: Array<{
    processor: string;
    model: string;
    status: string;
    result_text: string | null;
    result_meta?: unknown;
    processing_ms?: number | null;
    completed_at?: string | null;
    error?: string | null;
  }>;
}
