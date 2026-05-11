import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated access to environment variables.
 *
 * Every module in the project should import config values from here rather than
 * touching `process.env` directly. This gives us:
 *   - one place to document every variable
 *   - early failure with a readable message when something required is missing
 *   - type-safe, defaulted access in the rest of the code
 */
const EnvSchema = z.object({
  // --- model ---------------------------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  JARVIS_MODEL: z.string().min(1).default("anthropic:claude-opus-4-6"),
  JARVIS_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),

  // --- tools ---------------------------------------------------------------
  TAVILY_API_KEY: z.string().optional(),

  // --- composio ------------------------------------------------------------
  // API key for https://composio.dev. Without this, Composio toolkits are
  // silently skipped at agent build time and a warning is logged.
  COMPOSIO_API_KEY: z.string().optional(),
  // Composio user id used when fetching tools. Use a stable id per real user
  // for multi-user setups; "default" is fine for a single-tenant deployment.
  COMPOSIO_USER_ID: z.string().min(1).default("default"),

  // --- sandbox -------------------------------------------------------------
  // Deno Deploy organization/personal token (https://app.deno.com → Settings).
  // When set, every agent gets a `DenoSandbox` as its default backend, which
  // adds the `execute` tool (shell access) and lets skill scripts run inside
  // the sandbox. When unset, agents fall back to the no-shell setup.
  DENO_DEPLOY_TOKEN: z.string().optional(),
  // Optional Deno Deploy organisation slug (only required for personal tokens
  // starting with `ddp_`; org tokens starting with `ddo_` carry the org).
  DENO_DEPLOY_ORG: z.string().optional(),
  // Sandbox idle TTL. "session" = killed when this Node process exits;
  // duration strings ("20m", "1h" etc.) auto-expire even with active clients.
  // Default keeps a single sandbox alive for the whole `npm run chat` /
  // `npm run dev:graph` session.
  JARVIS_SANDBOX_TIMEOUT: z.string().min(1).default("session"),
  // Sandbox memory budget. Min 768MiB, max 4GiB on Deno.
  JARVIS_SANDBOX_MEMORY: z.string().min(1).default("1GiB"),

  // --- observability -------------------------------------------------------
  LANGSMITH_TRACING: z
    .union([z.literal("true"), z.literal("false")])
    .optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),

  // --- whatsapp frontend ---------------------------------------------------
  // Base URL of the scandi-wa-bot HTTP API (no trailing slash).
  // e.g. "http://127.0.0.1:8787" for local; "https://wa.scandi.internal" prod.
  WA_BOT_BASE_URL: z.string().url().optional(),
  // Bearer token configured as API_AUTH_TOKEN on the WA bot.
  WA_BOT_TOKEN: z.string().optional(),
  // Shared secret returned by `POST /v1/webhooks` (used to verify the
  // HMAC-SHA256 signature on every webhook delivery).
  WA_WEBHOOK_SECRET: z.string().optional(),
  // Comma-separated whitelist of chat JIDs Jarvis is allowed to respond in.
  // Empty / unset = no chats allowed (fail closed). Use "*" to allow all.
  JARVIS_WA_ALLOWED_CHATS: z.string().default(""),
  // HTTP port the WhatsApp frontend Fastify app listens on.
  JARVIS_WA_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Host the Fastify app binds to. Default 127.0.0.1 so a misconfigured
  // deployment can't accidentally expose the server publicly without a proxy.
  JARVIS_WA_HOST: z.string().default("127.0.0.1"),
  // Quiet-window before triggering a run after the last inbound message
  // arrives (resets on every new message in the same chat). Tunes how
  // aggressively rapid follow-ups get coalesced into one run.
  JARVIS_WA_DEBOUNCE_MS: z.coerce.number().int().min(0).default(5000),
  // Max time we wait for `message.processed` on a media message before
  // proceeding with whatever's available.
  JARVIS_WA_MEDIA_WAIT_MS: z.coerce.number().int().min(0).default(60000),
  // How many recent messages (per chat) to inject into the context block.
  JARVIS_WA_CONTEXT_MSGS: z.coerce.number().int().min(1).max(100).default(30),
  // Model used for chat summarisation (daily / weekly / long-term). Generous
  // token budget; default Claude Sonnet 4.6.
  JARVIS_SUMMARY_MODEL: z.string().min(1).default("anthropic:claude-sonnet-4-6"),
  // Postgres connection string. Hosted Supabase Postgres works; we also use it
  // for the langgraph-checkpoint-postgres saver. Required for the WA app
  // (the CLI still works without it).
  SUPABASE_DB_URL: z.string().optional(),
  // Per-agent-run hard cap on outbound WA tool calls (send/react/edit).
  // Belt-and-braces against runaway agents flooding a chat.
  JARVIS_WA_MAX_SENDS_PER_RUN: z.coerce.number().int().min(1).default(8),
  // Min interval (ms) between two outbound WA tool calls within one run.
  JARVIS_WA_MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(0).default(500),

  // --- workflows (deterministic scheduled tasks) ---------------------------
  // Default destination chat for workflow notifications. Workflows can
  // override per-task via their own env var (e.g. WORKFLOW_REVOLUT_CHAT_JID),
  // but most use this. Same JID format as JARVIS_WA_ALLOWED_CHATS entries.
  JARVIS_WORKFLOWS_DEFAULT_CHAT_JID: z.string().optional(),

  // Revolut expenses API (https://github.com/<you>/scandi-revolut-expenses).
  // Used by the `revolut-daily-expenses` workflow.
  REVOLUT_EXPENSES_API_BASE_URL: z.string().url().optional(),
  REVOLUT_EXPENSES_API_KEY: z.string().optional(),
  // Override the destination for the daily Revolut report. Falls back to
  // JARVIS_WORKFLOWS_DEFAULT_CHAT_JID if unset.
  WORKFLOW_REVOLUT_CHAT_JID: z.string().optional(),

  // --- runtime -------------------------------------------------------------
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment configuration. Check your .env file:\n${issues}`,
  );
}

export const env: Env = parsed.data;

/**
 * Returns true when the named optional credential is configured.
 * Useful for tools that should silently no-op when the user hasn't opted in.
 */
export function hasCredential(key: keyof Env): boolean {
  const value = env[key];
  return typeof value === "string" && value.length > 0;
}
