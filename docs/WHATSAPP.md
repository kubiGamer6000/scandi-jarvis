# WhatsApp Frontend — Operational Guide

This document covers **running and operating** the WhatsApp frontend for Jarvis. For the historical design discussion (alternatives we considered and rejected), see [WHATSAPP_PLAN.md](./WHATSAPP_PLAN.md). For agent-level guidance baked into the system prompt, see `src/agents/jarvis/prompt.ts` (`## WhatsApp frontend` section).

---

## 0. What it is

A Fastify HTTP server (`src/apps/whatsapp/`) that:

1. Receives webhooks from [`scandi-wa-bot`](https://github.com/scandi-gum/scandi-wa-bot).
2. Verifies HMAC, deduplicates, and trigger-filters them.
3. Dispatches each chat's messages through a per-chat state machine (debounce → run → optional hard-interrupt + restart).
4. Builds a fresh context block (chat header + summaries + chat notes + last 30 transcript msgs + triggering message) and invokes the shared `jarvis` DeepAgent.
5. Lets the agent reply via WhatsApp tools (`whatsapp_send_message`, `whatsapp_react`, `whatsapp_pull_file`, …) that hit the bot's REST API.

LangGraph state (`thread_id = chat.jid`) is persisted to Postgres via `PostgresSaver` — todos, scratch files, and intermediate reasoning survive across runs.

---

## 1. Components

| File                                                          | Role                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/apps/whatsapp/server.ts`                                 | Fastify boot, preflight, route registration, graceful shutdown.                         |
| `src/apps/whatsapp/webhook.ts`                                | Raw-body parsing, HMAC verify, idempotency check, parse `WebhookEnvelope`, dispatch.    |
| `src/apps/whatsapp/dispatcher.ts`                             | Per-chat state machine: debounce, run, hard-interrupt, `/stop`, loop-protection.        |
| `src/apps/whatsapp/runner.ts`                                 | Single-shot agent invocation: assemble context, invoke, capture outcome, fallback send. |
| `src/apps/whatsapp/context.ts`                                | Builds the `HumanMessage` (with Anthropic `cache_control` on the static prefix).        |
| `src/apps/whatsapp/summaries.ts`                              | Lazy daily / weekly / long-term incremental summarisation (Claude Sonnet 4.6).          |
| `src/apps/whatsapp/summarize-cron.ts`                         | Standalone worker for proactive summary refresh.                                        |
| `src/apps/whatsapp/media-wait.ts`                             | Polls bot for media-processing completion before invoking the agent.                    |
| `src/apps/whatsapp/idempotency.ts`                            | Postgres-backed webhook-ID dedupe with 24h TTL.                                         |
| `src/apps/whatsapp/commands.ts`                               | Pure slash-command parser (`/stop`).                                                    |
| `src/apps/whatsapp/whitelist.ts`                              | `JARVIS_WA_ALLOWED_CHATS` matcher.                                                      |
| `src/apps/whatsapp/client.ts`                                 | Typed REST client for the WA bot HTTP API.                                              |
| `src/apps/whatsapp/agent.ts`                                  | Composes the `jarvis-whatsapp` agent (Jarvis + WA tools + middleware).                  |
| `src/tools/whatsapp/*.ts`                                     | 8 WA-aware tools (send, react, edit, pull/send file, fetch, get, remember).             |
| `src/core/wa-rate-limit.ts`                                   | `wrapToolCall` middleware: hard cap + min interval on outbound WA actions per run.      |
| `src/core/db.ts`                                              | Singleton `pg.Pool` against `SUPABASE_DB_URL`.                                          |
| `db/migrations/001_jarvis_init.sql`                           | `jarvis.chat_context` + `jarvis.wa_webhook_seen` schema.                                |

---

## 2. Environment

Set in `.env` (see `.env.example` for the full list):

```env
# WA bot
WA_BOT_BASE_URL=https://your-wa-bot.example.com
WA_BOT_TOKEN=...
WA_WEBHOOK_SECRET=...

# Server
JARVIS_WA_HOST=0.0.0.0
JARVIS_WA_PORT=8088
JARVIS_WA_ALLOWED_CHATS=120363xxx@g.us,49xxx@s.whatsapp.net

# Tuning (defaults shown)
JARVIS_WA_DEBOUNCE_MS=5000
JARVIS_WA_MEDIA_WAIT_MS=20000
JARVIS_WA_CONTEXT_MSGS=30
JARVIS_WA_MAX_SENDS_PER_RUN=12
JARVIS_WA_MIN_SEND_INTERVAL_MS=500

# Persistence
SUPABASE_DB_URL=postgres://...

# Summaries
JARVIS_SUMMARY_MODEL=anthropic:claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-...
```

`SUPABASE_DB_URL`, `WA_BOT_BASE_URL`, `WA_BOT_TOKEN`, and `WA_WEBHOOK_SECRET` are mandatory — `server.ts` will refuse to start without them.

---

## 3. First-time setup

```bash
# 1. Install deps (one-time).
npm install

# 2. Apply DB migrations to Supabase.
psql "$SUPABASE_DB_URL" -f db/migrations/001_jarvis_init.sql

# 3. Smoke-test the WA bot client against your bot.
npm run smoke:wa-client

# 4. Run the dispatcher state-machine smoke test (no live bot needed).
npm run smoke:wa-dispatcher
```

---

## 4. Run

### Webhook server

```bash
npm run wa:server          # production
npm run wa:server:watch    # dev (tsx watch)
```

Health check:

```bash
curl http://localhost:8088/healthz
```

Configure the WA bot to POST to `https://<host>/wa-webhook` with `X-Webhook-Signature` (HMAC-SHA256 of the raw body using `WA_WEBHOOK_SECRET`).

### Summary cron

```bash
npm run wa:summarize-cron
```

Runs hourly by default. Refreshes daily summaries for any chat with new messages, and weekly summaries when the daily-through watermark advances past the weekly one. Long-term summaries roll forward when weekly does.

Deploy as a sidecar / cron job alongside the webhook server.

---

## 5. State machine

Each chat owns a small machine driven by `dispatcher.ts`:

```
        new msg                          new msg
Idle ──────────▶ Debouncing(5s) ──debounce──▶ Running ──finish──▶ Idle
                      │  │                     │
                      │  └── new msg: reset    │ new msg: abort + react 🔄
                      │     debounce           │             │
                      │                        ▼             │
                      │                     Aborting ────────┘
                      │                        │
                      │                        └── post-abort: restart with
                      │                            fresh context (latest seq)
                      ▼
                  /stop?  → StoppingFinal (cancel any in-flight run,
                            send 'I've stopped' + 🛑 react, drain queue,
                            return to Idle)
```

Notes:
- All processing for a chat funnels through a per-chat FIFO (`p-queue` with `concurrency: 1`) so we never run two invocations for the same chat at once.
- Loop protection: messages from `self.pn_jid` are dropped before they enter the queue.
- Group chats: only triggered when `mentioned_self` is `true` (the agent is `@`-mentioned).

---

## 6. Context block (what the agent sees)

For each run we build a single `HumanMessage` containing:

- chat header (`chat_jid`, `chat_type`, `chat_subject`, `participants`, `now`, `triggering_seq`)
- long-term summary (older than this week)
- weekly summary (~7 days)
- daily summary (~24h)
- chat notes ("AGENTS.md for this chat", written by `whatsapp_remember`)
- last `JARVIS_WA_CONTEXT_MSGS` (default 30) transcript lines (oldest first; our own messages appear as `you: …`)
- the triggering message
- "## What to do" instructions

Everything except the agent's tool calls and intermediate reasoning is **rebuilt fresh from Postgres + the bot's REST API on every run** — the WA history is never copied into LangGraph state. This keeps context bounded and avoids drift.

> Note on prompt caching: an earlier draft split this into two content blocks with `cache_control: { type: "ephemeral" }` on the static prefix, but Anthropic limits a single request to 4 cache breakpoints total and DeepAgents already places markers on the system prompt / tools / skills middleware. Adding ours pushed us to 5 and the API rejected runs with a 400. Caching is now handled upstream only.

---

## 7. Summarisation

Three rolling summaries, each watermarked by a `*_through_seq` column on `jarvis.chat_context`:

| Summary    | Window               | Refresh trigger                                                           |
| ---------- | -------------------- | ------------------------------------------------------------------------- |
| `daily`    | last ~24h            | new messages since `daily_through_seq` (lazy on read, eager via cron).    |
| `weekly`   | last ~7d             | `daily_through_seq` advanced past `weekly_through_seq` + threshold.       |
| `longterm` | everything older     | weekly rollover (the previous weekly is folded into long-term).           |

Each pass is **incremental**: we send the prior summary + the new chunk to Sonnet 4.6 with an "update this summary, keep names and unresolved threads" prompt. Token ceilings on each output prevent unbounded growth.

---

## 8. Tools (mid-run side-effects)

All defined in `src/tools/whatsapp/`:

| Tool                        | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `whatsapp_send_message`     | Reply to the chat. **This is the only thing the user sees.**                       |
| `whatsapp_react`            | Add / remove an emoji reaction on any message (great for "I'm working on it").     |
| `whatsapp_edit_message`     | Edit the agent's own recent messages (WA only allows ~15 min after send).          |
| `whatsapp_pull_file`        | Download media from a message into the agent's virtual filesystem.                 |
| `whatsapp_send_file`        | Upload a file from the virtual FS into the chat.                                   |
| `whatsapp_fetch_messages`   | Page deeper into history (the 30-message window often isn't enough).               |
| `whatsapp_get_message`      | Look up a single message by `seq` (used to inspect quotes).                        |
| `whatsapp_remember`         | Persist a note into `jarvis.chat_context.notes` (appended or named-section replace). |

Outbound actions (`send_message`, `react`, `edit_message`, `send_file`) are wrapped by `createWhatsappRateLimitMiddleware` (`src/core/wa-rate-limit.ts`):
- hard cap: `JARVIS_WA_MAX_SENDS_PER_RUN` outbound calls per agent run
- min spacing: `JARVIS_WA_MIN_SEND_INTERVAL_MS` between calls

---

## 9. Safety nets

- **Fallback final send.** If the agent finishes a normal (non-aborted, non-errored) run and never called `whatsapp_send_message` but produced a substantive final `AIMessage`, the runner sends that text to the chat as a fallback and logs a warning. (`p4-fallback-send`)
- **LangSmith tagging.** Every run is tagged `frontend:whatsapp`, `chat_type:*`, `chat_jid:*`, optionally `from_pn:*`, plus metadata for `triggering_seq`, transcript size, summary presence, sender info. (`p4-tracing`)
- **Prompt caching.** Handled entirely by DeepAgents' upstream middleware on the system prompt / tools / skills. We do *not* add our own `cache_control` markers on the run context — see the note in §6 above. (`p4-prompt-cache`)
- **Webhook dedupe.** `X-Webhook-Id` is recorded in `jarvis.wa_webhook_seen` with a 24h TTL; replays are no-ops.
- **HMAC verify.** Constant-time compare of `X-Webhook-Signature` against `HMAC-SHA256(raw_body, WA_WEBHOOK_SECRET)`. Tolerance window on `X-Webhook-Timestamp` rejects stale replays.

---

## 10. Healthchecks

- `GET /healthz` — server liveness + DB ping + bot client ping.
- `npm run smoke:wa-dispatcher` — pure unit-style smoke for the state machine.
- `npm run smoke:wa-client` — talks to a live WA bot (`/v1/health`, `/v1/me`, optional send/react).
- `scripts/wa-smoke.ts` — end-to-end (POST a canned webhook, assert a reply lands within N seconds). See `scripts/wa-smoke.ts`.

---

## 11. Troubleshooting

| Symptom                                              | Likely cause                                                                                                | Where to look                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Webhook returns 401                                  | HMAC mismatch — wrong `WA_WEBHOOK_SECRET` or proxy modified the body.                                       | `webhook.ts` (`verifySignature`). Inspect `X-Webhook-*` headers. |
| Same message processed twice                         | `X-Webhook-Id` missing / changing on retry.                                                                 | `idempotency.ts`. Check `jarvis.wa_webhook_seen` table.       |
| Agent never replies                                  | Triggering chat not in `JARVIS_WA_ALLOWED_CHATS`, OR group message without `mentioned_self`.                | `whitelist.ts`, dispatcher logs `dropped: …`.                  |
| Agent runs but no message in WA                      | `whatsapp_send_message` not called; safety net should kick in. Check rate-limit middleware (cap exhausted). | `runner.ts` "fallback final send" log, `wa-rate-limit.ts`.    |
| Hot loop                                             | Agent reacting to its own messages.                                                                         | Dispatcher loop-protection on `from.jid === self.pn_jid`.     |
| Summaries stale                                      | Cron not running, or `SUPABASE_DB_URL` unset.                                                               | `npm run wa:summarize-cron` logs, `jarvis.chat_context` rows. |
| Media missing from context                           | Bot hadn't finished processing before our `JARVIS_WA_MEDIA_WAIT_MS` budget expired.                         | `media-wait.ts`. Increase the env var or check bot health.    |

---

## 12. Add / change a WhatsApp-aware capability

1. **New WA tool**: drop a file in `src/tools/whatsapp/<name>.ts` that exports a factory `(client, opts) => StructuredTool`. Add it to `createWhatsappTools` in `src/tools/whatsapp/index.ts`. If it does outbound WA actions, add its name to the list `createWhatsappRateLimitMiddleware` wraps (`src/core/wa-rate-limit.ts`).
2. **New summary kind**: extend the column set in `db/migrations/00x_*.sql` (alongside `daily/weekly/longterm`) and add a `refresh*IfStale` in `summaries.ts`. Wire it into `context.ts`.
3. **Tighter / looser tuning knob**: thread an env var through `src/core/env.ts` first, never read `process.env` directly elsewhere.

For non-WA capabilities (regular tools, subagents, skills), use the patterns described in [DEVELOPMENT.md](./DEVELOPMENT.md). The WA frontend is just another `apps/` entrypoint — the agent itself is the same Jarvis.
