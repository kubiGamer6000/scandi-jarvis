# WhatsApp Frontend — Operational Guide

This document covers **running and operating** the WhatsApp frontend for Jarvis. For the historical design discussion (alternatives we considered and rejected), see [WHATSAPP_PLAN.md](./WHATSAPP_PLAN.md). For agent-level guidance baked into the system prompt, see `src/agents/jarvis/prompt.ts` (`## WhatsApp frontend` section).

---

## 0. What it is

A Fastify HTTP server (`src/apps/whatsapp/`) that:

1. Receives webhooks from [`scandi-wa-bot`](https://github.com/scandi-gum/scandi-wa-bot).
2. Verifies HMAC, deduplicates, and trigger-filters them.
3. Dispatches each chat's messages through a per-chat state machine (debounce → run → optional hard-interrupt + restart).
4. Builds a context block (full on a session's first run: chat header + summaries + chat notes + last 30 transcript msgs + triggering message; a delta of new messages on later runs) and invokes the shared `jarvis` DeepAgent.
5. Lets the agent reply via WhatsApp tools (`whatsapp_send_message`, `whatsapp_react`, `whatsapp_pull_file`, …) that hit the bot's REST API.

LangGraph state is persisted to Postgres via `PostgresSaver`, per **session** (`thread_id = <chat_jid>#<base36 start time>`, see §6.1) — todos, scratch files, and intermediate reasoning survive across the runs of a session.

---

## 1. Components

| File                                                          | Role                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/apps/whatsapp/server.ts`                                 | Fastify boot, preflight, route registration, graceful shutdown.                         |
| `src/apps/whatsapp/webhook.ts`                                | Raw-body parsing, HMAC verify, idempotency check, parse `WebhookEnvelope`, dispatch.    |
| `src/apps/whatsapp/dispatcher.ts`                             | Per-chat state machine: debounce, run, hard-interrupt, `/stop`, loop-protection.        |
| `src/apps/whatsapp/runner.ts`                                 | Single-shot agent invocation: assemble context, invoke, capture outcome, fallback send. |
| `src/apps/whatsapp/context.ts`                                | Builds the per-run `HumanMessage` (full context or session delta).                       |
| `src/apps/whatsapp/sessions.ts`                               | In-memory per-chat agent sessions (thread id, idle / max-runs rotation, seen-seq).      |
| `src/apps/whatsapp/summaries.ts`                              | Background daily / weekly / long-term incremental summarisation (Claude Sonnet 5).      |
| `src/apps/whatsapp/summarize-cron.ts`                         | Standalone worker for proactive summary refresh.                                        |
| `src/apps/whatsapp/media-wait.ts`                             | Polls bot for media-processing completion before invoking the agent.                    |
| `src/apps/whatsapp/typing.ts`                                 | Holds the "typing…" indicator open for the lifetime of a run.                            |
| `src/apps/whatsapp/idempotency.ts`                            | Postgres-backed webhook-ID dedupe with 24h TTL.                                         |
| `src/apps/whatsapp/commands.ts`                               | Pure slash-command parser (`/stop`).                                                    |
| `src/apps/whatsapp/whitelist.ts`                              | Access gate: allowed senders (people) + allowed group chats.                            |
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
JARVIS_WA_ALLOWED_SENDERS=359884430293,46768505515,46704832998   # who may use Jarvis
JARVIS_WA_ALLOWED_CHATS=120363xxx@g.us,49xxx@s.whatsapp.net   # groups it participates in

# Tuning (defaults shown)
JARVIS_WA_DEBOUNCE_MS=2500
JARVIS_WA_SESSION_IDLE_MIN=45
JARVIS_WA_SESSION_MAX_RUNS=15
JARVIS_WA_MEDIA_WAIT_MS=60000
JARVIS_WA_CONTEXT_MSGS=30
JARVIS_WA_MAX_SENDS_PER_RUN=12
JARVIS_WA_MIN_SEND_INTERVAL_MS=500
JARVIS_WA_TYPING_ENABLED=true
JARVIS_WA_TYPING_KEEPALIVE_MS=40000
JARVIS_WA_TYPING_TTL_MS=120000

# Persistence
SUPABASE_DB_URL=postgres://...

# Model (see §6.3 Latency)
ANTHROPIC_API_KEY=sk-ant-...
JARVIS_MODEL=anthropic:claude-opus-5
# JARVIS_EFFORT=            # unset = API default (high)
JARVIS_FAST_MODE=false
JARVIS_REFUSAL_FALLBACK=true

# Summaries
JARVIS_SUMMARY_MODEL=anthropic:claude-sonnet-5
JARVIS_SUMMARY_IDLE_MS=120000
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

Runs hourly by default. Applies the same refresh policy as the server's background refresh (§7) to the daily and weekly summaries of every enabled chat in `jarvis.chat_context`.

Optional: the webhook server already refreshes summaries in the background after runs. Deploy as a sidecar / cron job alongside it if you want quiet chats kept warm too.

---

## Access control

Two gates in [`whitelist.ts`](../src/apps/whatsapp/whitelist.ts), both applied in
`Dispatcher.ingest` **before** anything else — no debounce, no typing indicator,
no model call, and `/stop` from an outsider does nothing:

| Gate | Env | Applies to |
|---|---|---|
| People | `JARVIS_WA_ALLOWED_SENDERS` | every inbound message, DM or group |
| Groups | `JARVIS_WA_ALLOWED_CHATS` | group chats only |

A DM from an allowed sender needs no chat entry: a DM's JID flips between PN
(`4670…@s.whatsapp.net`) and LID (`1873…@lid`) form, so listing it is
unreliable. Senders are matched on the bare id (digits before `:` or `@`), so
the phone number, the LID and a device-suffixed LID (`…:25@lid`) all resolve to
the same person — list whichever you have, both is safest.

Both default to empty, which means nobody: the server refuses to start with no
allowed senders, and warns when no group is listed. `*` opens a gate entirely
and is for local development only — Jarvis reads live business data.

Groups keep the addressing rule on top: an allowed sender must still @-mention
Jarvis or reply to one of its messages.

`npm run check:access` asserts the truth table (the three of us in every
identity form, strangers in DMs and groups, unapproved groups, lookalike
numbers).

## 5. State machine

Each chat owns a small machine driven by `dispatcher.ts`:

```
        new msg                          new msg
Idle ──────────▶ Debouncing(2.5s) ─debounce─▶ Running ──finish──▶ Idle
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

Presence during a run:

- **Read receipts** are not our concern — the wa-bot acks every live inbound message on its own, in every DM and group, before the webhook even reaches us. Nothing to configure here; see `docs/API.md` §6.7 in the bot repo if blue ticks aren't showing.
- **"Typing…"** goes up when a run starts (`runner.ts` → `typing.ts`) and comes down when the run settles, whichever way it ends. We start the indicator before media-wait and context building, because that's already time the user is waiting on us. The bot owns the chatstate refresh cadence; Jarvis just opens the session, re-asserts it every `JARVIS_WA_TYPING_KEEPALIVE_MS` (40s) while the run is in flight, and closes it in a `finally`.
  - The indicator disappears the moment the bot sends a message, so a reply never lands under a stale "typing…". If the agent keeps working after sending (multi-message turns), the next keepalive re-opens it — which reads like a person typing again.
  - Sessions carry a `ttl_ms` (`JARVIS_WA_TYPING_TTL_MS`, 2 min), so a crashed or wedged Jarvis can't leave a chat typing indefinitely.
  - Kill switch: `JARVIS_WA_TYPING_ENABLED=false`.

Notes:
- All processing for a chat funnels through a per-chat FIFO (`p-queue` with `concurrency: 1`) so we never run two invocations for the same chat at once.
- Loop protection: messages from `self.pn_jid` are dropped before they enter the queue.
- Group chats: only when the bot is **addressed** — either **@-mentioned** (`mentioned_self` / `mentioned_jids` matched against PN/LID, `:device` stripped) **or** a WhatsApp swipe-**reply** to one of the bot's messages (`quoted.from_me` or `quoted.from_jid` matches PN/LID). Plain group chatter without either still drops.

---

## 6. Context block (what the agent sees)

For each run we build a single `HumanMessage`. On the **first run of a session** (§6.1) it contains:

- chat header (`chat_jid`, `chat_type`, `chat_subject`, `participants`, `now`, `triggering_seq`)
- long-term summary (older than this week)
- weekly summary (~7 days)
- daily summary (~24h)
- chat notes ("AGENTS.md for this chat", written by `whatsapp_remember`)
- last `JARVIS_WA_CONTEXT_MSGS` (default 30) transcript lines (oldest first; our own messages appear as `you: …`)
- the triggering message
- "## What to do" instructions

On **later runs of the same session** the thread already holds all of that, so the block is a delta: chat header, only the messages that arrived since the previous run (with a note pointing at `whatsapp_fetch_messages` if more arrived than the 30-message window), the triggering message, and a one-line "What to do". No summaries or notes.

The trigger, recent transcript and `jarvis.chat_context` row are fetched concurrently. Summaries are read as-is — they're never refreshed on the reply path (§7). The WA history is rebuilt from Postgres + the bot's REST API rather than trusted from LangGraph state; the thread only carries what the agent saw and did during the current session.

### 6.1 Sessions

A chat's runs share one LangGraph thread, `thread_id = <chat_jid>#<base36 session start time>` (`sessions.ts`), so the model keeps its own tool results and reasoning between turns and the prompt cache serves the whole prefix. A session ends — and the next run starts a fresh thread with the full context block — when:

- the chat has been idle for `JARVIS_WA_SESSION_IDLE_MIN` (45) minutes,
- the session has served `JARVIS_WA_SESSION_MAX_RUNS` (15) runs,
- a run fails (errored, non-aborted), or
- the process restarts (sessions are in-memory only).

Aborted runs (hard-interrupt) don't advance the session's seen-seq watermark, so the restart re-renders those messages.

Why bounded: previously every chat used one thread (`thread_id = chat_jid`) forever. Those grew to ~250K tokens (a DM) and ~590K tokens (the ops group) and were re-sent on every model call. Long-lived memory belongs in summaries and notes. Old bare-jid threads are no longer read.

### 6.2 Prompt caching

On. DeepAgents' Anthropic caching middleware puts a breakpoint on the system prompt and an automatic one on the last message (5-minute TTL). Because a session thread is append-only, every model call after the first reads the system prompt, tools and earlier turns from cache — ~99% cache reads on follow-up turns in benchmarks. We don't add our own `cache_control` markers to the context block (Anthropic caps a request at 4; see the troubleshooting row in DEPLOYMENT.md).

### 6.3 Latency

What a reply costs, in order:

1. **Debounce** — `JARVIS_WA_DEBOUNCE_MS` (2500) of quiet after the last inbound message.
2. **Prep** — media-wait on the trigger (only if it has unprocessed media, up to `JARVIS_WA_MEDIA_WAIT_MS`) + concurrent context fetches. Logged as `prep_ms` on the `invoke` line.
3. **Model calls** — first call (thinking + first tool call) until the first `whatsapp_send_message` / `whatsapp_react`, then any follow-up calls. Dominated by output tokens and effort; input size matters far less with caching on.

Nothing else runs inline: summaries refresh in the background after the run (§7). For reference, a simple DM reply used to take ~54s (5s debounce, ~38s of three sequential summary LLM calls before the agent, ~6.5s first model call over an uncached, unbounded thread).

Knobs:

| Env                                   | Default                     | Effect                                                                                                       |
| ------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `JARVIS_MODEL`                        | `anthropic:claude-opus-5`   | Adaptive thinking on by default, 16K max output.                                                              |
| `JARVIS_EFFORT`                       | unset (= API `high`)        | `low` / `medium` / `high` / `xhigh` / `max`. Lower is faster and cheaper on routine turns.                   |
| `JARVIS_FAST_MODE`                    | `false`                     | Opus 5 / 4.8 fast mode (faster output, premium pricing). Needs fast-mode rate limits on the org — ours currently has 0, so leave off. |
| `JARVIS_REFUSAL_FALLBACK`             | `true`                      | Opus 5 / Fable: a refusal is retried server-side on a fallback model (`fallbacks: "default"`) instead of ending the turn. |
| `JARVIS_WA_DEBOUNCE_MS`               | `2500`                      | Coalescing window vs. time-to-start.                                                                          |
| `JARVIS_WA_SESSION_IDLE_MIN` / `JARVIS_WA_SESSION_MAX_RUNS` | `45` / `15` | How long a thread (and its cache) is reused before starting fresh.                                     |
| `JARVIS_SUMMARY_IDLE_MS`              | `120000`                    | Quiet period after a run before the background summary refresh.                                               |

Reading the logs — the runner's `invoke` line carries `thread_id`, `session_run` (1 = fresh session, full context) and `prep_ms`; `run complete` carries `duration_ms` and `usage`, summed over **this run's** model calls only:

```
usage: {"model_calls":2,"input_tokens":…,"output_tokens":…,"cache_read_tokens":…,"cache_write_tokens":…}
```

On `session_run > 1`, `cache_read_tokens` should be most of the input; `cache_write_tokens` close to the whole input on a continuing run means the cache missed (e.g. more than 5 minutes passed since the previous turn). High `output_tokens` with few `model_calls` points at thinking depth — try a lower `JARVIS_EFFORT`.

Benchmark: `npm run bench:wa` (`scripts/bench-wa-latency.ts`) drives a 3-turn scripted DM through the real runner with real LLM calls against a stubbed wa-bot and prints time to first visible action, total run time, and input / cache-read tokens per turn. Costs real tokens. Pick configs with `BENCH_CONFIGS` (`opus4.6`, `opus5`, `opus5-medium`, `opus5-low`, `opus5-fast`; default `opus4.6,opus5,opus5-medium,opus5-fast`):

```bash
BENCH_CONFIGS=opus5,opus5-low npm run bench:wa
```

Measured on this architecture: Opus 5 first visible reply 2.8–3.9s, 3.9–5.1s total per turn; Opus 4.6 4.1–6.4s / 6.6–8.2s.

---

## 7. Summarisation

Three rolling summaries, each watermarked by a `*_through_seq` column on `jarvis.chat_context`:

| Summary    | Window               | Refresh when (since its `*_through_seq` watermark)                        |
| ---------- | -------------------- | ------------------------------------------------------------------------- |
| `daily`    | last ~24h            | ≥ 15 new messages, or older than 3h and any new message.                  |
| `weekly`   | last ~7d             | ≥ 60 new messages, or older than 24h and any new message.                 |
| `longterm` | everything older     | ≥ 300 new messages, or older than 7d and any new message.                 |

Summaries **never run on the reply path.** After each non-aborted run the runner calls `scheduleSummaryRefresh(chat)`, which waits until the chat has been quiet for `JARVIS_SUMMARY_IDLE_MS` (2 min; each run resets the timer) and then refreshes daily / weekly / long-term concurrently. At most one refresh per chat runs at a time. The hourly cron (§4) still exists for quiet chats.

Staleness is measured by fetching this chat's messages past the watermark (seqs are global across chats, so seq arithmetic doesn't work): a small probe of `minNewMessages` first, the full window only if the summary is due. Watermarks never move backwards, so a slower concurrent refresh can't clobber a newer one.

Each pass is **incremental**: we send the prior summary + the new chunk to `JARVIS_SUMMARY_MODEL` (default Sonnet 5) with an "update this summary, keep names and unresolved threads" prompt. Token ceilings on each output prevent unbounded growth.

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

Outbound actions (`send_message`, `react`, `edit_message`, `send_file`, plus `revolut_send_expense_report`) are wrapped by `createWhatsappRateLimitMiddleware` (`src/core/wa-rate-limit.ts`):
- hard cap: `JARVIS_WA_MAX_SENDS_PER_RUN` outbound calls per agent run
- min spacing: `JARVIS_WA_MIN_SEND_INTERVAL_MS` between calls

A "run" is keyed on `thread_id` + triggering seq. (Earlier builds keyed on the tool-call id, which is unique per call, so the caps never applied.)

---

## 9. Safety nets

- **Fallback final send.** If the agent finishes a normal (non-aborted, non-errored) run and never called `whatsapp_send_message` but produced a substantive final `AIMessage`, the runner sends that text to the chat as a fallback and logs a warning. Only this run's messages are inspected (everything after its input message), not earlier runs in the session thread. (`p4-fallback-send`)
- **LangSmith tagging.** Every run is tagged `frontend:whatsapp`, `chat_type:*`, `chat_jid:*`, optionally `from_pn:*`, plus metadata for `triggering_seq`, transcript size, summary presence, sender info. (`p4-tracing`)
- **Prompt caching.** DeepAgents' Anthropic caching middleware, enabled. We do *not* add our own `cache_control` markers on the run context — see §6.2. (`p4-prompt-cache`)
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
| Agent never replies                                  | **Whitelist:** group `…@g.us` not in `JARVIS_WA_ALLOWED_CHATS` and `*` not set. **Groups:** message didn’t @mention the bot and isn’t a reply to one of its messages. **Debug:** `LOG_LEVEL=debug` and look for `dropping group msg without @mention or reply-to-bot` or `dropping non-whitelisted chat`. |
| Agent runs but no message in WA                      | `whatsapp_send_message` not called; safety net should kick in. Check rate-limit middleware (cap exhausted). | `runner.ts` "fallback final send" log, `wa-rate-limit.ts`.    |
| Hot loop                                             | Agent reacting to its own messages.                                                                         | Dispatcher loop-protection on `from.jid === self.pn_jid`.     |
| Summaries stale                                      | Expected up to the §7 thresholds. Otherwise `SUPABASE_DB_URL` unset, or the refresh is failing.            | `background summary refresh failed` / `llm update failed` logs, `jarvis.chat_context` rows. |
| Replies slow                                         | See §6.3. Compare `prep_ms`, `duration_ms` and `usage` on the runner log lines.                            | `npm run bench:wa` to separate model latency from chat/infra. |
| Media missing from context                           | Bot hadn't finished processing before our `JARVIS_WA_MEDIA_WAIT_MS` budget expired.                         | `media-wait.ts`. Increase the env var or check bot health.    |
| No "typing…" while Jarvis works                      | `JARVIS_WA_TYPING_ENABLED=false`, `TYPING_ENABLED=false` on the bot, or the bot's socket is down (the endpoint 503s). | `typing keepalive failed` at debug level; bot's `/v1/health`. |
| Chat stuck showing "typing…"                         | Jarvis died mid-run. Self-heals when `JARVIS_WA_TYPING_TTL_MS` lapses on the bot side.                      | `DELETE /v1/chats/:jid/typing` on the bot clears it now.      |
| Messages never marked read                           | Bot-side setting, not Jarvis: `READ_RECEIPTS_ENABLED`, or read receipts disabled in the WA account's privacy settings (then WhatsApp only sends `read-self`). | Bot logs on connect: `read receipts enabled` / warning.       |

---

## 12. Add / change a WhatsApp-aware capability

1. **New WA tool**: drop a file in `src/tools/whatsapp/<name>.ts` that exports a factory `(client, opts) => StructuredTool`. Add it to `createWhatsappTools` in `src/tools/whatsapp/index.ts`. If it does outbound WA actions, add its name to the list `createWhatsappRateLimitMiddleware` wraps (`src/core/wa-rate-limit.ts`).
2. **New summary kind**: extend the column set in `db/migrations/00x_*.sql` (alongside `daily/weekly/longterm`) and add a `refresh*IfStale` in `summaries.ts`. Add it to `refreshAllIfStale` (background refresh) and render it in `context.ts` (full-context block only).
3. **Tighter / looser tuning knob**: thread an env var through `src/core/env.ts` first, never read `process.env` directly elsewhere.

For non-WA capabilities (regular tools, subagents, skills), use the patterns described in [DEVELOPMENT.md](./DEVELOPMENT.md). The WA frontend is just another `apps/` entrypoint — the agent itself is the same Jarvis.
