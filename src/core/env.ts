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
  JARVIS_MODEL: z.string().min(1).default("anthropic:claude-opus-5"),
  // Thinking depth / token spend for Claude models. Unset = API default
  // (`high`). Lower is faster and cheaper on routine turns.
  JARVIS_EFFORT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  ),
  // Opus fast mode: ~2.5x faster output at 2x token price (Claude API only).
  JARVIS_FAST_MODE: z
    .union([z.literal("true"), z.literal("false")])
    .default("false"),
  // Server-side refusal fallbacks on Opus 5 / Fable (see core/models.ts).
  JARVIS_REFUSAL_FALLBACK: z
    .union([z.literal("true"), z.literal("false")])
    .default("true"),
  // Optional. Newer Claude models (Opus 4.7+ / Sonnet 5+) reject non-default
  // sampling params with HTTP 400 — leave unset to omit temperature entirely.
  JARVIS_TEMPERATURE: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.coerce.number().min(0).max(2).optional(),
  ),

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
  // Which sandbox backs the agent's `execute` tool (see core/sandbox.ts):
  //   local = bubblewrap-isolated shell on this host (default, free)
  //   deno  = Deno Deploy sandbox, falling back to local when unavailable
  //   none  = no shell at all
  JARVIS_SANDBOX_PROVIDER: z.enum(["local", "deno", "none"]).default("local"),
  // Host directory for the local sandbox (workspace, scratch, toolchain).
  // Relative paths resolve against the process cwd.
  JARVIS_SANDBOX_DIR: z.string().min(1).default(".sandbox"),
  // Wall-clock limit per `execute` call on the local sandbox.
  JARVIS_SANDBOX_EXEC_TIMEOUT_SEC: z.coerce.number().int().min(5).default(300),
  // Cap on command output returned to the agent.
  JARVIS_SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1000).default(60_000),
  // Max size of any single file a sandboxed command may write.
  JARVIS_SANDBOX_MAX_FILE_MB: z.coerce.number().int().min(1).default(512),
  // Allow outbound network from inside the local sandbox (pip, curl, APIs).
  JARVIS_SANDBOX_NETWORK: z
    .union([z.literal("true"), z.literal("false")])
    .default("true"),
  // Max commands running at once in the local sandbox.
  JARVIS_SANDBOX_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(2),

  // Deno Deploy organization/personal token (https://app.deno.com → Settings).
  // Only used when JARVIS_SANDBOX_PROVIDER=deno.
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
  JARVIS_WA_DEBOUNCE_MS: z.coerce.number().int().min(0).default(2500),
  // A chat's agent thread (the conversation the model sees, prompt-cached)
  // is reused across runs until the chat has been quiet this long, or it has
  // served this many runs. Then a fresh thread starts from summaries + notes
  // + the recent transcript. Keeps every model call small and cache-friendly.
  JARVIS_WA_SESSION_IDLE_MIN: z.coerce.number().int().min(1).default(45),
  JARVIS_WA_SESSION_MAX_RUNS: z.coerce.number().int().min(1).default(15),
  // Chat summaries refresh in the background once a chat has been quiet this
  // long after a run (never inline before a reply).
  JARVIS_SUMMARY_IDLE_MS: z.coerce.number().int().min(0).default(120_000),
  // Max time we wait for `message.processed` on a media message before
  // proceeding with whatever's available.
  JARVIS_WA_MEDIA_WAIT_MS: z.coerce.number().int().min(0).default(60000),
  // How many recent messages (per chat) to inject into the context block.
  JARVIS_WA_CONTEXT_MSGS: z.coerce.number().int().min(1).max(100).default(30),
  // Model used for chat summarisation (daily / weekly / long-term). Generous
  // token budget; default Claude Sonnet 5. Runs in the background.
  JARVIS_SUMMARY_MODEL: z.string().min(1).default("anthropic:claude-sonnet-5"),
  // Postgres connection string. Hosted Supabase Postgres works; we also use it
  // for the langgraph-checkpoint-postgres saver. Required for the WA app
  // (the CLI still works without it).
  SUPABASE_DB_URL: z.string().optional(),
  // Per-agent-run hard cap on outbound WA tool calls (send/react/edit).
  // Belt-and-braces against runaway agents flooding a chat.
  JARVIS_WA_MAX_SENDS_PER_RUN: z.coerce.number().int().min(1).default(8),
  // Min interval (ms) between two outbound WA tool calls within one run.
  JARVIS_WA_MIN_SEND_INTERVAL_MS: z.coerce.number().int().min(0).default(500),
  // Show "typing…" in the chat while a run is in flight. The bot owns the
  // chatstate refresh cadence; Jarvis only opens and closes the session.
  JARVIS_WA_TYPING_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .default("true"),
  // How often we re-assert the typing session while a run is in flight. Must
  // stay comfortably below JARVIS_WA_TYPING_TTL_MS.
  JARVIS_WA_TYPING_KEEPALIVE_MS: z.coerce
    .number()
    .int()
    .min(5000)
    .default(40000),
  // Lifetime we ask the bot to hold the indicator for. If Jarvis dies
  // mid-run, the bot stops typing once this lapses.
  JARVIS_WA_TYPING_TTL_MS: z.coerce.number().int().min(10000).default(120000),

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
