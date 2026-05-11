# WhatsApp Layer for Jarvis — System Design

> Status: **decided & implemented** (Phases 1–4). This document is the historical design record and the source of truth for *why* the WhatsApp layer looks the way it does. For day-to-day operations, see [WHATSAPP.md](./WHATSAPP.md). For a quick architecture overview, see [ARCHITECTURE.md](./ARCHITECTURE.md). For agent-level guidance, see [AGENTS.md](./AGENTS.md).

---

## 0. Goal

Make WhatsApp the **primary interface** for Jarvis. Reuse what `deepagents`/`langgraph` already give us, write only the thin glue that's actually load-bearing.

**Inputs we have:**

- `scandi-wa-bot` — durable webhooks, REST send/react/edit/delete, message history paginated by `seq`, media stored on GCS, AI-processed text descriptions for every image/video/audio/PDF (`media.processed.text`).
- `scandi-jarvis` — deep agent with planning, virtual filesystem, subagents, sandbox shell, skills, MemorySaver thread checkpointer.

**The three problems we have to solve:**

1. **Mid-run side effects.** Reactions and intermediate messages while the agent thinks, not just one final reply.
2. **Context management.** Chats are infinite; we can't naïvely put every WA message into a LangGraph thread.
3. **File transfer.** Pull a file from a WA message into the agent's filesystem and send a file back out.

---

## 1. Recommended architecture (the TL;DR)

```
   WA bot ──webhook──▶ src/apps/whatsapp/server.ts (Fastify)
                                │
                  (verify HMAC, dedupe, trigger-filter)
                                │
                  per-chat FIFO queue (1 run in flight / chat)
                                │
                                ▼
              ┌───────────────────────────────────────────┐
              │  agent.invoke({                            │
              │    messages: [HumanMessage(<context>)],    │
              │    context: { chatJid, triggeringSeq, … }, │
              │    config:  { configurable: {              │
              │      thread_id: chat.jid                   │
              │    } }                                     │
              │  })                                        │
              └───────────────────────────────────────────┘
                                │
                  Jarvis (DeepAgent) — same shape as today,
                  but with extra WA tools, a beforeModel
                  middleware, a per-chat thread, and access
                  to a "whatsapp" skill + (optional) /memories
                  store route for chat summaries.

   While running: tools call back into the WA bot REST API
                  to react, send, pull files, fetch history.
```

Key shape decisions, all elaborated below:

| Decision | Recommended choice | Why |
| --- | --- | --- |
| Entry point | New Fastify app in `src/apps/whatsapp/` | Mirrors the `apps/cli.ts` pattern; entry-points layer is exactly where it belongs |
| Thread mapping | `thread_id = chat.jid` (one per chat, forever) | Free per-chat persistence of todos, files, intermediate reasoning |
| Where WA history lives | **Not** in LangGraph messages — re-injected fresh each turn | Avoids unbounded context growth, never drifts |
| Sending intermediate messages | Explicit tool calls (`whatsapp_send_message`, `whatsapp_react`) | Tools run mid-graph, so side effects happen during the run — no streaming wiring needed |
| Final reply | Same explicit tool (no implicit auto-send), with a fallback that sends the final AI text if the agent forgot | Predictable, agent stays in control |
| Files in | `whatsapp_pull_file(seq, destPath)` writes into the agent's virtual FS | Reuses existing FS + sandbox path |
| Files out | `whatsapp_send_file(filePath, caption?)` reads from the agent's virtual FS, POSTs multipart | Same |
| Summaries | Lazy + incremental, stored in StoreBackend under `/memories/chats/<jid>/` | Cross-thread persistence is exactly what `StoreBackend` is for |
| Checkpointer | Switch `MemorySaver` → `PostgresSaver` for the WA app | We need durability across restarts |

The rest of this doc is the alternatives we ruled out and why.

---

## 2. Entry point: where does the webhook handler live?

**Options**

- **(A) New Fastify app under `src/apps/whatsapp/server.ts`** — symmetric with `apps/cli.ts`, owns webhook verify, dedupe, queue, agent invoke, send. Pure entry-point, no business logic.
- **(B) Inside the LangGraph dev server** — `langgraph dev` already runs a server, but it doesn't accept arbitrary HTTP routes; we'd still need a wrapper.
- **(C) A separate repo / service** — over-modular for now; the agent and the trigger are tightly coupled.

**Recommended: (A).** The repo's [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) explicitly reserves `apps/` for "CLI today; HTTP server / cron jobs / Slack bot later" — this is exactly that. One folder, one HTTP server, one process running Jarvis.

```
src/apps/whatsapp/
├── server.ts        # Fastify app: routes + boot
├── webhook.ts       # POST /wa-webhook handler: verify, dedupe, dispatch
├── queue.ts         # Per-chat FIFO + run-state
├── runner.ts        # Builds + invokes the agent, plumbs context/thread
├── client.ts        # Typed REST client for the WA bot
└── context.ts       # Builds the "context block" injected into each run
```

Webhook receipt should always 200 the bot within ~1s — actual run happens out-of-band on the queue worker.

---

## 3. Trigger filter (when does Jarvis actually run?)

Spec from the brief:

- DM → every inbound message triggers a run.
- Group → only when `mentioned_self === true`.
- Skip everything with `from_me === true` (the bot already filters this).
- Subscribe to **both** `message.received` and `message.processed`. For media messages we need the processed text in context, so:
  - If the message has media → wait for `message.processed` to fire the run (drop the corresponding `message.received` for media).
  - If text-only → fire on `message.received`.
  - Belt-and-braces: if `message.processed` doesn't arrive within ~60s, fall back to running with `media.processed = null` (rare; the WA bot's pipeline normally finishes within seconds).

Edge cases worth a config flag:

- **Quiet hours / kill switch** — env var or chat-level toggle (`/jarvis off` etc.) to silence the bot temporarily.
- **Allowed chats** — start with a `JARVIS_WA_ALLOWED_CHATS=<comma-separated jids>` allowlist so a misconfigured webhook can't leak Jarvis into random chats.

---

## 4. Concurrency: one run per chat, queued

If two messages arrive from the same chat 5 seconds apart, we don't want two parallel runs racing on the same `thread_id` checkpointer.

**Options**

- **(A) Per-chat in-memory FIFO mutex** — simple `Map<chatJid, PQueue>`; backs up to memory during a burst.
- **(B) Per-chat advisory lock in Postgres** — survives multiple webhook-server instances. Needed only if we ever scale horizontally.
- **(C) Coalesce + debounce** — wait N seconds after the last message before triggering, so a flurry of three "@jarvis ... actually also ... ah and one more thing" gets one run. Optional.
- **(D) Interrupt + restart** — kill the running graph, start a new one. Wastes work; bad UX.

**Recommended: (A) now, leave a hook for (B) when we scale.** Optionally pair with a small **debounce (2–5s)** before triggering — feels much more natural in real human chats. Implementation note: LangGraph's [`MemorySaver`](https://docs.langchain.com/oss/javascript/langgraph/persistence) (and Postgres equivalent) already handles "two `invoke` calls on the same `thread_id` serially" via the checkpointer; the queue is mainly so we don't double-process.

While a run is in flight, **incoming messages are not lost** — they sit in the WA bot's DB; the next run will pull them via context injection anyway.

---

## 5. Thread mapping: `thread_id = chat.jid`

The single best decision we can make: **one LangGraph thread per WhatsApp chat, forever.** That gives us:

- A persistent place for Jarvis's todos, virtual filesystem entries, scratch notes, partial reports.
- Free continuity across turns in the same chat ("here's another column for the report you made yesterday" → Jarvis still has the original Python script in `/scratch/chat_<jid>/report.py`).
- Trivially scoped: a chat's state never leaks into another chat.

**Caveats**

- We need a **persistent checkpointer**, not `MemorySaver`. Use [`@langchain/langgraph-checkpoint-postgres`](https://docs.langchain.com/oss/javascript/langgraph/persistence#checkpointer-libraries) (same Postgres as the WA bot, in its own schema).
- LangGraph state isn't free of context cost — the messages list grows. **This is exactly why we do not put WA messages into the thread's messages list** (next section). The agent's own AI/tool messages within a single run are fine; we let `SummarizationMiddleware` collapse them when needed.
- Files in the StateBackend filesystem are part of state too — namespace per chat (`/scratch/chats/<short_jid>/...`) so older scratch from another chat doesn't pile up.

Alternative considered: **one thread per "task"** (auto-create on each trigger, throw away after). Loses turn-to-turn memory and forces us to rebuild every time. Worse.

---

## 6. Context management — the hard problem

> The big claim: **WhatsApp message history is its own database. We do not duplicate it into LangGraph state.** Each run, we pull a fresh slice from the WA bot's REST API and feed it to the agent as a `HumanMessage` (or `SystemMessage`) prefix. The agent's *own* in-thread state captures only its working memory (todos, scratch files, intermediate reasoning).

### 6.1 Why not just put every WA message into `messages: []`?

It would be the easiest mapping, but:

- A 6-month-old groupchat with 50k messages can't fit in any window — you'd hit context limits on turn 1.
- DeepAgents' `SummarizationMiddleware` triggers at 85% of `max_input_tokens` and would summarise on every single turn from day 2 onwards; massive waste.
- Edit/delete/reaction events would need replay logic to mutate prior `HumanMessage`s; messy.

### 6.2 Recommended pattern: ephemeral context, persistent agent state

On each trigger, the runner builds **one** `HumanMessage` for the model that looks like this (rough template):

```
You're acting in WhatsApp chat <chat.subject or "DM with Dolan">
  (jid=<chat.jid>, type=<dm|group>, participants=<N>).
You are tagged as @<bot.push_name>.

— LONG-TERM SUMMARY (older than 7 days, ~200 tokens) —
<from /memories/chats/<jid>/long_term.md, see §7>

— THIS WEEK SUMMARY (last 7d, ~400 tokens) —
<from /memories/chats/<jid>/weekly.md>

— RECENT TRANSCRIPT (last 20 messages, oldest first) —
[seq=42150 18:01 Dolan]: …
[seq=42152 18:03 Dolan, 📎 PDF "report.pdf" – AI summary: …]: convert this to docx
[seq=42153 18:03 you]: 👍 (reaction)
…

— TRIGGERING MESSAGE (seq=42168) —
[seq=42168 18:10 Dolan, @you]: actually also include returns

Reply per the system prompt. Use whatsapp_send_message to talk to the user.
```

Notes on this format:

- The agent **sees `seq` for every message** — that's the handle for `whatsapp_pull_file`, `whatsapp_react`, `whatsapp_get_message`, and `quote_seq` in sends.
- Media is rendered inline as `📎 <kind> "<filename>" – AI summary: <text>` using the WA bot's `media.processed.text`. The original bytes are NOT included.
- The bot's previous sends in this chat appear as `you: …`, so the agent has a clear conversational history without needing them in `messages[]`.
- This entire block is one `HumanMessage`. The agent's previous in-thread messages (its own reasoning, tool calls, prior `whatsapp_send_message` results) are still there from the checkpointer — they give it continuity *across* runs.

### 6.3 How the block is built (the `whatsapp_context` middleware)

A custom `beforeModel` middleware (DeepAgents has this hook) runs at the start of each invocation and:

1. Reads `chat_jid`, `triggering_seq` from `runtime.context`.
2. Hits `GET /v1/chats/{jid}/messages?before_seq=triggering_seq+1&limit=20` (configurable `N`).
3. Reads/refreshes summaries from the StoreBackend (see §7).
4. Formats into the template above.
5. Replaces / prepends the user message in the request.

Alternative: do this in the Fastify runner before calling `agent.invoke()` instead of in middleware.

| | In the runner (pre-`invoke`) | In a middleware |
| --- | --- | --- |
| Simplicity | ✅ Plain JS, easy to test | Slightly more ceremony |
| Reuse | ❌ Only the WA app | ✅ Same agent reused elsewhere (CLI, LangGraph dev, future Slack) shares the logic |
| Re-fetch on second graph turn | ❌ Only built once | ✅ Can refresh on `beforeModel` (rarely needed) |

**Recommended: build it in the runner** for v1 — simplest, no middleware surprise. Move it into middleware later if/when we add Slack or want re-fetch semantics. (The brief about LangGraph middleware in your shared docs is mostly about middleware's value for shared cross-cutting concerns; a single entrypoint doesn't need it yet.)

### 6.4 What about really long history queries?

When the agent needs more than the prefix (e.g. "what did we say about returns in Q4?"), it calls `whatsapp_fetch_messages` (see §9) — paginated, on demand. That's the escape hatch: low cost when not used, full power when needed.

---

## 7. Summaries: how do they get built?

We need two summaries per chat (numbers tunable):

- **`long_term.md`** — everything older than 7 days, rolled up. Highly compressed (~200 tok).
- **`weekly.md`** — last 7 days, ~300–500 tok.

**Where they live**

- **Option (A): WA bot's Postgres** — extend the bot's schema with a `chat_summaries` table.
- **Option (B): DeepAgents StoreBackend** under `/memories/chats/<jid>/`. With a `CompositeBackend`, the StateBackend handles `/scratch/...` (thread-scoped) and StoreBackend handles `/memories/...` (cross-thread, persistent). This is the exact pattern in [DeepAgents memory docs](https://docs.langchain.com/oss/javascript/deepagents/customization#memory).
- **Option (C): On-disk file via `FilesystemBackend`.**

**Recommended: (B).** The store is built for cross-thread persistence, gives us LangGraph-native APIs, and means the agent itself can read/write these files via `read_file`/`write_file` if we want it to maintain them.

**How they're refreshed**

- **(i) Synchronous + lazy.** When the runner builds the context block, it checks: are the summary files older than X hours OR has the seq window since-summary grown by > N? If yes, run a small "summarisation" LLM call now (with the most recent batch) and overwrite. Adds latency to that one run.
- **(ii) Background cron worker.** A separate process polls active chats hourly and refreshes summaries. No latency on user-facing runs.
- **(iii) Agent-managed.** The agent has a `whatsapp_update_summary` tool and a system-prompt rule that says "if the summary is stale, update it before answering". Most flexible, least predictable.

**Recommended: (i) for v1, migrate to (ii) once we have >10 active chats.** Concrete heuristic:

```ts
shouldRefresh(weekly) =
  weekly === null
  || ageHours(weekly) > 6
  || msgsSinceLastUpdate >= 20

shouldRefresh(longTerm) =
  longTerm === null
  || ageHours(longTerm) > 24*7
  || msgsSinceLastUpdate >= 200
```

Refresh logic: a single Anthropic/Gemini call that takes `(previous_summary, new_messages_since)` and returns a tighter merged summary. Cheap, deterministic. We can run it from `core/` (not as a tool, as an internal helper called by the runner).

> Alternative considered: a `summarizer-agent` **subagent** that owns the summary pipeline. Too much ceremony for one LLM call — subagents are for *long* sub-tasks (like Shopify reports). A plain util fn is cleaner.

---

## 8. Persistence layout

| What | Where | Why |
| --- | --- | --- |
| Webhook idempotency keys (`X-Webhook-Id`) | Postgres table (or Redis), 24h TTL | Required for at-least-once delivery |
| LangGraph checkpoints (one thread per chat) | `PostgresSaver` | Durable agent state across restarts |
| `/scratch/...` virtual files | StateBackend (in-checkpoint) | Auto-scoped to the chat thread |
| `/memories/chats/<jid>/...` (summaries, profiles) | StoreBackend | Cross-thread; persists between restarts |
| WhatsApp message bodies | **Stay in the WA bot's Postgres.** Jarvis fetches via REST, never duplicates. | Single source of truth |
| Files Jarvis pulled (e.g. a PDF the user sent) | `/scratch/chats/<jid>/pulls/<seq>-<filename>` | Thread-scoped, cleaned up when thread is | 

The recommended `backend:` shape in `buildAgent`:

```ts
backend: new CompositeBackend(
  sandbox ?? new StateBackend(),                    // default route
  { "/memories/": new StoreBackend() }              // cross-thread route
)
```

…and add `store: <PostgresStore>` to `createDeepAgent`.

---

## 9. The WhatsApp tool surface

Design principles:

1. **Agent never thinks about JIDs.** `chat_jid` is in `runtime.context`; tools read it directly. The agent passes `seq` (a number) to refer to messages.
2. **Tools are coarse-grained around intent**, not 1:1 with REST endpoints. `whatsapp_pull_file(seq, destPath)` does fetch + write — the agent doesn't deal with download URLs.
3. **Responses are LLM-shaped.** `whatsapp_fetch_messages` returns a formatted transcript string (same format as the context block), not raw JSON.
4. **Strong tool descriptions** — these go straight into the system prompt and matter a lot for routing.
5. **Tools that produce side effects on WA log loudly** in LangSmith.

### 9.1 Recommended toolkit

```ts
//
// — Speaking —
//
whatsapp_send_message({
  text: string,
  quote_seq?: number,
  mentions?: string[],                // JIDs to @-mention
})
// → { seq, wa_message_id }

whatsapp_react({
  seq: number,
  emoji: string,                       // "" to clear
})
// → ok

//
// — Files —
//
whatsapp_send_file({
  file_path: string,                   // path in virtual FS
  caption?: string,
  quote_seq?: number,
  kind?: "image"|"video"|"audio"|"document"|"sticker",  // auto-inferred from ext if omitted
  as_voice_note?: boolean,             // audio + ptt:true
})
// → { seq, wa_message_id }

whatsapp_pull_file({
  seq: number,
  dest_path: string,                   // virtual FS path the file will be written to
})
// → { bytes_written, mime_type, kind, file_name? }

//
// — Reading —
//
whatsapp_fetch_messages({
  before_seq?: number,
  after_seq?: number,
  limit?: number,                      // default 50, max 100
})
// → formatted transcript string

whatsapp_get_message({ seq: number })
// → full structured payload (for when the agent needs the full record)
```

### 9.2 What we deliberately did NOT add

- `whatsapp_edit` / `whatsapp_delete` — high footgun, low value, only works on `from_me`. Skip v1.
- `whatsapp_list_chats` — the agent always operates in the current chat. Listing chats is for an admin UI, not the bot.
- `whatsapp_search_messages` — the WA bot doesn't expose this yet; if we need it, we'd add a server-side full-text index first. Punt.
- `whatsapp_send_typing` — WA doesn't expose typing indicators in the API; use a `⏳` reaction instead.

### 9.3 Final-reply semantics (very important)

Two viable patterns:

| | Implicit auto-send of final AI message | Explicit `whatsapp_send_message` only |
| --- | --- | --- |
| Mid-run sends | Tool calls | Tool calls |
| Final reply | Runner reads `state.messages[-1].content` and sends it | Agent must call `whatsapp_send_message` itself |
| Pros | Simpler agent prompt | Full control, agent can stay silent on purpose, agent can split into N final messages, no double-send risk |
| Cons | Can double-send if agent ALSO calls `send_message` with same text; runner has to dedupe | Agent may forget to send anything |

**Recommended: explicit-only, with a "you forgot to talk" fallback.** The agent's last AI message is treated as internal thinking — never sent. If the run ends without a single `whatsapp_send_message`, the runner:

1. Logs a warning to LangSmith.
2. Looks at the last AI message text; if it has substantive content (>20 chars), sends it as a fallback.
3. Otherwise sends a generic "I tried to handle that but didn't produce a response — check the logs."

This pattern is cleaner because it makes the system prompt teach a clear rule: **"Speaking to the user is always a tool call."** Reacting first is encouraged. Long-running tasks should `whatsapp_send_message("Working on it, give me ~30s")` early, then send the result.

### 9.4 Should this be a subagent?

Decision: **no, direct tools on Jarvis.** The WA tools *are* Jarvis's voice — delegating to a subagent breaks the model of "Jarvis is talking to me". The big exception (potential v2) is a `chat-historian` subagent for deep dives: "@jarvis, find every time we mentioned returns last quarter" — that subagent could paginate through hundreds of messages and return a tight summary, isolated from main context.

---

## 10. Files: pull and push, end-to-end

### 10.1 In: user sends a PDF, "@jarvis convert to docx"

1. `message.received` webhook arrives → media isn't processed yet; ignore.
2. `message.processed` webhook arrives → trigger a run.
3. Context block contains: `[seq=42173 📎 PDF "report.pdf", 12 pages — AI summary: "Q1 sales report ..."]: convert this to docx`.
4. Agent decides: "I need the actual file."
5. Agent calls `whatsapp_pull_file({ seq: 42173, dest_path: "/scratch/in/report.pdf" })`.
6. Tool calls `GET /v1/messages/42173/media/download?proxy=true`, streams bytes, writes to the agent's virtual FS at `/scratch/in/report.pdf`.
7. Agent calls `execute({ command: "libreoffice --headless --convert-to docx /scratch/in/report.pdf --outdir /scratch/out/" })` (sandbox needed — we already have Deno; for office conversion we'd need a different sandbox or a remote service, but the pattern holds).
8. Agent calls `whatsapp_send_file({ file_path: "/scratch/out/report.docx", caption: "Here you go. Want me to clean up any sections?" })`.

The two non-trivial questions:

- **Should `pull_file` use `?proxy=true`?** Yes — the agent runs from our side. Bypassing the Firebase token URL keeps everything on a single auth path and works even if Firebase is blocked from the sandbox network.
- **Does Deno sandbox have `libreoffice`?** No. For office conversions we'd need either a different sandbox provider (Modal/Daytona with a wider image) or a separate microservice. Document conversion is out of scope for v1; sticking with PDF processing tools that exist in Deno (or chained REST APIs) is fine for the demo.

### 10.2 Out: agent built a chart, sends it

1. Agent generates a PNG inside the sandbox via `execute` (e.g. a Python plot) at `/scratch/chart.png`.
2. Agent calls `whatsapp_send_file({ file_path: "/scratch/chart.png", caption: "Chargebacks last 7 days" })`.
3. Tool reads the bytes via the backend's `read_file` API, POSTs to `/v1/send/multipart`. (Multipart avoids base64 overhead and is the WA bot's preferred path.)
4. Returns the `seq` of the sent message — agent can `quote_seq` it later.

---

## 11. Media in the context: text descriptions only

For everything except an explicit pull, the agent sees the **AI-processed text** from the WA bot (`media.processed.text`). It does NOT see the raw image/PDF bytes.

Reasons:

- Cost: a few thousand tokens of description vs. multimodal image inputs every turn.
- Consistency across models: the agent doesn't suddenly behave differently when a chat has lots of media.
- Privacy/audit: text descriptions are easy to log.

**Edge cases**

- The `message.received` for media arrives BEFORE the `message.processed`. We wait for `processed` (default) so we always have the text. Configurable per-chat.
- If a processor fails (`media.processed = null`), the context block shows `📎 <kind> "<filename>" — (processing failed)`. The agent can still pull the file if needed.
- View-once messages: the bot stores them like normal; treat them the same way.

---

## 12. Skills, prompts, profiles

### 12.1 A new `whatsapp` skill

Per [DeepAgents skill docs](https://docs.langchain.com/oss/javascript/deepagents/skills), a skill is progressive-disclosure docs that the agent loads only when relevant. Perfect for WA conventions:

```
skills/whatsapp/conventions/SKILL.md
  ├─ When to react vs reply
  ├─ How to use `quote_seq` and `mentions`
  ├─ When to send long vs short messages (WA is mobile)
  ├─ How seq IDs map to messages
  └─ Common phrases (acknowledge → work → deliver)
```

This keeps the main Jarvis system prompt small. The skill body is only loaded into context when the agent decides WA-routing matters.

### 12.2 Jarvis system prompt updates

Tiny additions:

- "You primarily talk on WhatsApp. The current chat is provided in the user message prefix; you don't need to look up its JID."
- "Talking to the user is always a tool call to `whatsapp_send_message`. Your final assistant message is internal."
- "For long tasks: react with ⏳ on the triggering message, send a short ack, do the work, then send the result. React ✅ when done."
- "When you see `[seq=N 📎 …]`, that's an attachment. Pull it with `whatsapp_pull_file` if you need the bytes; otherwise the AI summary is your view of the file."

### 12.3 Profiles

DeepAgents [harness profiles](https://docs.langchain.com/oss/javascript/deepagents/profiles) can append a tiny suffix to the system prompt for specific models — useful if we ever route between Claude and Gemini for WA runs (e.g. cost-tier routing for short DM acks vs. complex group queries). Not needed v1.

---

## 13. Middleware: what's already free, what to add

| Middleware | Source | Use it? |
| --- | --- | --- |
| `TodoListMiddleware` | DeepAgents (default) | ✅ Free todos, perfect for "@jarvis do these 5 things" |
| `FilesystemMiddleware` | DeepAgents (default) | ✅ Free virtual FS |
| `SubAgentMiddleware` | DeepAgents (default) | ✅ Already used by `shopify-agent` |
| `SummarizationMiddleware` | DeepAgents (default) | ✅ Backstop for in-run blowup (lots of tool calls); compresses long intra-run context |
| `AnthropicPromptCachingMiddleware` | DeepAgents (default w/ Claude) | ✅ The context block is identical-prefix across turns of the same chat; caching the summary block is real savings |
| `PatchToolCallsMiddleware` | DeepAgents (default) | ✅ Helpful when a WA tool call fails mid-graph |
| `JarvisSkillsSandboxSync` | Existing | ✅ Keep as is |
| **`WhatsAppContextMiddleware`** | New (optional) | ⚠️ Build only if context-injection-in-runner isn't enough (see §6.3) |
| **`WhatsAppSendRateLimitMiddleware`** | New | ✅ Wrap `whatsapp_send_message` / `whatsapp_react` with a token bucket so the agent can't spam (e.g. 1 send per 2s, max 8 per run) |
| **`WhatsAppCancelMiddleware`** | New (v2) | If we ever want "@jarvis stop" to interrupt a long run |

The rate-limit middleware is small but valuable insurance. Implement as `wrapToolCall` keyed by `runtime.context.chat_jid`.

---

## 14. Streaming: do we need it?

The brief asks: "we want it to be able to send reactions & messages while it's running".

That's already covered by **tool calls executing mid-graph** — when the agent calls `whatsapp_react`, the tool runs, hits the WA API, and the reaction appears immediately. No streaming required from us.

Where streaming WOULD help:

- **Live LangSmith-style debug stream to a dashboard** — nice to have, low priority.
- **Long single AIMessage that you want to send in chunks** — not how we want this to work anyway; the agent should split into discrete `whatsapp_send_message` calls.

**Recommended: `.invoke()` for v1, switch to `.stream()` later if we want progress visibility on a dashboard.** Cost is identical.

---

## 15. Rate limiting, guardrails, safety

- **WA itself is sensitive to bursts.** The WA bot's docs note ~5 msg/sec ceiling. Our rate-limit middleware (§13) gives us an upstream cap.
- **Loop protection.** The WA bot filters `from_me=true`, so Jarvis sending a message can't re-trigger itself. Belt-and-braces: double-check `from.jid` against `accountId` in the webhook handler.
- **Tool-call cap per run.** Bound `whatsapp_send_message` to, say, 8 invocations / run. After that it errors. Prevents runaway agents flooding chats.
- **Confirmation gates for destructive actions.** Use DeepAgents [`interrupt_on`](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop) to require human approval before the agent can call tools we deem dangerous (Shopify mutations that change live data, deletes, etc.). The approval flow could be its own WA-mediated UX: the agent sends "About to: <action>. Reply Y/N", another middleware listens for the reply. v2 polish.
- **Auth.** WA bot bearer token lives in `env.WA_BOT_TOKEN` (new var). Webhook secret in `env.WA_WEBHOOK_SECRET`. Both validated by the existing Zod schema in `core/env.ts`.

---

## 16. Observability

- **LangSmith** already wired up. Tag each run with `chat_jid`, `chat_type`, `from_pn`, `triggering_seq` via `runtime.context` — these become filterable in the LangSmith UI.
- **Per-run summary log** at end: which tools fired, total tokens, total elapsed, summary refresh? (yes/no), context-block size.
- **WA bot side** already logs deliveries; cross-reference by `X-Webhook-Id` if we need to debug an event end-to-end.

---

## 17. Open questions for you

These are the calls I'd want you to make before we start coding:

1. **Group-chat scope.** Today: only respond when @-mentioned. Should the agent be allowed to *self-trigger* a follow-up send a few seconds later (e.g. "Working on it…" then later "Here's the report")? Yes, by design — but worth confirming.
2. **Per-chat opt-out.** Want a `JARVIS_WA_ALLOWED_CHATS=` whitelist (safer) or `JARVIS_WA_BLOCKED_CHATS=` blacklist (more permissive)? Recommend: whitelist for v1.
3. **Summary cadence.** Are 6h / 7d / 24h refresh thresholds (§7) sensible for your usage? They might be too aggressive on a quiet chat.
4. **Implicit final-message send.** Stick with the recommended "explicit-only + fallback" (§9.3), or prefer auto-send of last AI message? Recommended: explicit-only.
5. **Persistence backend.** Reuse the WA bot's Postgres (shared instance, separate schema) or a fresh one? Recommended: reuse — single DB to operate.
6. **MVP vs v2 split.** I've drafted a phased rollout below — feel free to slice differently.

---

## 18. Phased rollout

### Phase 1 — MVP (≈1 week of focused work)

- [ ] `src/apps/whatsapp/server.ts` — Fastify, webhook + HMAC + dedupe (in-memory Set is fine for MVP).
- [ ] `src/apps/whatsapp/queue.ts` — per-chat FIFO.
- [ ] `src/apps/whatsapp/client.ts` — typed REST client for the WA bot.
- [ ] `src/apps/whatsapp/runner.ts` — composes the HumanMessage context block and invokes the agent. **No summary yet — just the last 30 raw messages.**
- [ ] `src/tools/whatsapp/*` — `send_message`, `react`, `pull_file`, `send_file`, `fetch_messages`, `get_message`.
- [ ] System prompt updates + a `skills/whatsapp/conventions/SKILL.md`.
- [ ] Switch checkpointer to `PostgresSaver` *(can stay `MemorySaver` for very early dev)*.
- [ ] Rate-limit middleware on outbound WA tool calls.
- [ ] Test in a dedicated test group.

### Phase 2 — Context engineering (≈2–4 days)

- [ ] Lazy summary refresh (weekly + long-term) with `StoreBackend`.
- [ ] CompositeBackend wiring for `/memories/`.
- [ ] Move context-block construction into a `beforeModel` middleware once it's well-shaped.
- [ ] Anthropic prompt-cache marker on the static-summary prefix.

### Phase 3 — Polish & v2 (as needed)

- [ ] Background cron summary worker.
- [ ] `chat-historian` subagent for deep history searches.
- [ ] Human-in-the-loop confirmation flow for destructive actions, surfaced through WA.
- [ ] "@jarvis stop" interrupt.
- [ ] Cost-tier routing across models per chat type (Haiku for DM acks, Sonnet for heavy work).
- [ ] Per-user profile under `/memories/users/<jid>/profile.md`.
- [ ] Admin endpoints (`/admin/chats`, `/admin/reset/<jid>`) for operating the bot.

---

## 19. What we explicitly do NOT build

To keep this from sprawling:

- **No Shopify changes.** The `shopify-agent` subagent works unchanged; it's invoked by Jarvis the same way regardless of who triggered Jarvis.
- **No new sandbox.** Reuse the Deno sandbox; if conversions need libreoffice/etc., that's a separate decision.
- **No multi-WhatsApp-account support.** The WA bot is single-account; one Jarvis instance per WA account.
- **No replacement of the CLI.** `apps/cli.ts` keeps working for local dev / quick chats with Jarvis — useful for testing changes without going through WA.
- **No own message storage.** The WA bot owns message storage; Jarvis only reads via REST.

---

## Appendix A — Minimal end-to-end trace (sanity-check)

```
1. Phone: "@jarvis, send me last 7d chargebacks as a PDF"
2. WA → bot → webhook fires: message.received (text only)
3. Fastify /wa-webhook: verify HMAC ✓, dedupe ✓, dispatch to per-chat queue.
4. Queue worker: runner.run(event).
5. runner builds:
     - context = fetch /v1/chats/<jid>/messages?limit=20&before_seq=<triggering+1>
     - summary = read /memories/chats/<jid>/{weekly,long_term}.md (cached, fresh)
     - HumanMessage = template(chat, summary, transcript, triggering)
   then agent.invoke({messages: [HumanMessage]}, { configurable: { thread_id: <jid> }, context: {chat_jid, triggering_seq, …} })
6. Inside the graph:
     - planning: write_todos(["pull data", "render PDF", "send"])
     - whatsapp_react(seq=42168, emoji="👀")        ← appears on phone
     - whatsapp_send_message(text="Sec, looking it up")  ← appears on phone
     - task(shopify-agent, "give me chargebacks for last 7d as a table")
     - <shopify-agent returns markdown table>
     - execute("python /skills/.../pdfgen.py …")  → /scratch/cb.pdf
     - whatsapp_send_file(file_path="/scratch/cb.pdf", caption="Here you go")
     - whatsapp_react(seq=42168, emoji="✅")
     - final AIMessage: "(internal) done"   ← NOT sent
7. runner: no fallback needed; finishes.
8. agent state checkpointed under thread_id=<jid>: todos, /scratch/cb.pdf, message log.
9. Next time the user sends in the same chat, the thread already has cb.pdf and the prior reasoning — Jarvis can refer back to it.
```

That trace is the litmus test for the design: every primitive used is something we've explicitly designed for above.
