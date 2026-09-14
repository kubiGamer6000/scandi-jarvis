# Architecture

Jarvis is intentionally small right now — but the layout is chosen so that it can grow into a multi-agent platform without restructuring later.

## Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/         CLI today; HTTP server / cron jobs / Slack bot later       │ ← entrypoints
├──────────────────────────────────────────────────────────────────────────┤
│ agents/       Each agent = folder { index, prompt, tools }               │ ← personalities
│ subagents/    Specialised, delegated-to agents with their own            │
│               prompt/tools/skills (none declared today)                  │
├──────────────────────────────────────────────────────────────────────────┤
│ tools/        Reusable tools, indexed in `registry.ts`                   │ ← capabilities
│ skills/       On-disk Agent-Skills bundles, opted into per (sub)agent    │
│ kit/          Scandi API clients + business knowledge, used by skills    │
│ integrations/ Host-side services (the kit credential gateway)            │
├──────────────────────────────────────────────────────────────────────────┤
│ core/         env, logger, model factory, deepagents wrapper,            │
│               sandbox provisioning, skills-sync middleware               │ ← infrastructure
└──────────────────────────────────────────────────────────────────────────┘
```

Dependencies always point **down** — entrypoints depend on agents, agents depend on subagents/tools/skills, everyone depends on `core/`. Tools and subagents never import from `agents/` or `apps/`.

## Why DeepAgents

[`deepagents`](https://docs.langchain.com/oss/javascript/deepagents/overview) is an "agent harness": the standard tool-calling loop plus four batteries-included capabilities we'd otherwise have to build ourselves:

- a planning tool (`write_todos`)
- a virtual filesystem (`read_file`, `write_file`, `edit_file`, `ls`, `glob`, `grep`) to offload context
- a `task` tool that spawns isolated **subagents** for sub-problems
- an opinionated base system prompt that teaches the model how to use the above

Everything else — choice of LLM, custom tools, subagents, memory, human-in-the-loop, sandboxes — is opt-in via `createDeepAgent` parameters. We wrap that call in [`core/agent.ts`](../src/core/agent.ts) so every agent in the repo gets consistent defaults.

## How an agent is built

Each agent lives in `src/agents/<name>/` and is just three small files:

```
src/agents/jarvis/
├── prompt.ts   # JARVIS_SYSTEM_PROMPT — appended on top of the deepagents base prompt
├── tools.ts    # picks tool names from the registry
└── index.ts    # exports `definition` + `build()` via core/agent.ts
```

`build()` calls `buildAgent(definition)` from `core/agent.ts`, which:

1. Resolves the model via `core/models.ts` (default: `anthropic:claude-opus-5`, configurable via `JARVIS_MODEL`; Anthropic options `JARVIS_EFFORT`, `JARVIS_FAST_MODE`, `JARVIS_REFUSAL_FALLBACK`). The model profile's `maxInputTokens` is capped at `JARVIS_CONTEXT_WINDOW_TOKENS` (default 300K) — DeepAgents' summarization middleware compacts a conversation at ~85% of that value (≈255K instead of ≈850K on a 1M-token model). The API limit itself is unchanged.
2. Loads any declared Composio tools (no-op if `COMPOSIO_API_KEY` is unset) and merges them with the local tools.
3. Resolves each subagent (its own tools, composio config, model, skill paths).
4. Picks a backend (see [Backends below](#backends-filesystem-and-shell)) and, when the sandbox is enabled, attaches a `beforeAgent` middleware that mirrors `./skills/` and `./kit/` into the sandbox.
5. Calls `createDeepAgent({ name, model, tools, systemPrompt, subagents, backend, middleware, skills, checkpointer })`.
6. Returns the compiled LangGraph agent — so callers can use `.invoke`, `.stream`, etc.

## Subagents

Specialised subagents (separate from the harness's auto-attached `general-purpose` one) live under `src/subagents/<name>/` with the same `{ prompt, tools, index }` shape as agents — except the index exports a `SubAgentDefinition` instead of a full `AgentDefinition`. The parent agent declares them on `definition.subagents`; `buildAgent` resolves them and DeepAgents wires them into the parent's `task` tool.

Subagents **share the parent's backend instance** (so the same sandbox + skills mount), but their `messages` and `todos` are isolated — only the final string result of a `task` call bubbles back to the parent.

No specialised subagents are declared today: `jarvis` uses its skills directly and hands long, data-heavy analyses to the auto-attached `general-purpose` subagent, which inherits the same tools and skill sets. See [`docs/AGENTS.md`](./AGENTS.md) for the live inventory.

## Skills

`skills/<set>/<skill>/SKILL.md` are reusable, progressive-disclosure capability bundles. An agent or subagent opts into a skill set by name (`skillSets: ["jarvis"]`); `buildAgent` mounts that set at the virtual path `/home/app/skills/<set>/`, and the DeepAgents skills middleware exposes each skill's `name` + `description` in the agent's system prompt. The full `SKILL.md` body is only read by the agent when the task matches.

See [`docs/DEVELOPMENT.md#skills`](./DEVELOPMENT.md#skills) for the layout and authoring rules.

## Backends (filesystem and shell)

`buildAgent` picks one of three backend topologies based on whether a sandbox is configured and whether any agent declared skill sets:

| Sandbox available?  | Skills declared? | Default backend | `/home/app/skills/` mounted at | `execute` (shell) tool |
| ------------------- | ---------------- | --------------- | ------------------------------ | ---------------------- |
| yes                 | yes              | `JarvisSandbox` | `FilesystemBackend(./skills)`  | ✓                      |
| yes                 | no               | `JarvisSandbox` | —                              | ✓                      |
| no                  | yes              | `StateBackend`  | `FilesystemBackend(./skills)`  | —                      |
| no                  | no               | `StateBackend` (DeepAgents default) | — | — |

"Sandbox available" means `JARVIS_SANDBOX_PROVIDER` is `local` (default) or `deno` **and** a provider actually started; with `none`, or if startup fails, agents degrade to `StateBackend`.

`JarvisSandbox` (see [`src/core/sandbox.ts`](../src/core/sandbox.ts)) is a process-singleton that extends deepagents' `BaseSandbox`, started on the first `buildAgent` call and shared across every agent and subagent in that Node process. It forwards `execute` / `uploadFiles` / `downloadFiles` to the live provider — a bubblewrap-isolated shell on the host ([`sandbox-local.ts`](../src/core/sandbox-local.ts)) or a Deno Deploy sandbox that fails over to local ([`sandbox-deno.ts`](../src/core/sandbox-deno.ts)) — and swaps providers underneath without the agent noticing. A `beforeAgent` middleware (see [`src/core/skills-sync.ts`](../src/core/skills-sync.ts)) health-checks the sandbox and mirrors `./skills/` into `/home/app/skills/...` and `./kit/` into `/home/app/kit/...` before each invocation (each skipped when unchanged), so scripts shipped with a skill can be executed via `execute` at the same path the agent reads them from.

Detailed providers, isolation, lifecycle and env vars: [`docs/DEVELOPMENT.md#sandbox-shell--executable-skills`](./DEVELOPMENT.md#sandbox-shell--executable-skills).

## Scandi data (kit gateway)

Live business data — the Profit API (our dashboard), Shopify Admin, Skio, Meta Marketing API and Triple Whale — reaches the agent through **skills + sandboxed scripts**, not LangChain tools. Three pieces:

- **`skills/jarvis/scandi-*`** — `SKILL.md` routing and rules, plus a CLI per service (`profit.ts`, `query.ts`, `skio.ts`, `creatives.ts`).
- **`kit/`** — `kit/lib/*.ts` API clients (`profitApi`, `shopify`, `skio`, `meta`, `triplewhale`, plus `http` retry/pacing, `cache`, `args`, `fx`, `creativeName`, `env`) and `kit/knowledge/*.md` (business overview, metrics dictionary, profit model, MRR, ad structure, pitfalls, …). Ported from the desktop Scandi agent kit with the same logic, except `env.ts` holds no credentials and every network call goes to the gateway. Mirrored into the sandbox at `/home/app/kit/` like the skills.
- **[`src/integrations/kit-gateway.ts`](../src/integrations/kit-gateway.ts)** — a `node:http` server on `127.0.0.1:<random port>` in the Jarvis process. It holds the credentials and forwards to the real APIs.

**Request flow.**

1. On the first local-sandbox start, `JarvisSandbox` calls `startKitGateway()`. It enables each service whose credentials are set, generates a per-process random token, and passes the sandbox `KIT_GATEWAY_URL`, `KIT_GATEWAY_TOKEN`, `KIT_SERVICES` and non-secret config (`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_API_VERSION`, `META_API_VERSION`, `META_AD_ACCOUNT_IDS`) as extra env. No credentials are configured → no gateway, no kit env.
2. The agent runs e.g. `tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts summary --days 7`. The script imports `/home/app/kit/lib/profitApi.ts`, which asks `env.ts` for `gateway("profit")` (throwing a readable error if the gateway env is missing or the service isn't in `KIT_SERVICES`).
3. The client calls `http://127.0.0.1:<port>/profit/<path>` with `x-kit-token`. The sandbox shares the host network namespace, so loopback reaches the gateway.
4. The gateway checks the token, the service and the read-only policy, attaches the credential and forwards upstream:

   | Gateway route                            | Upstream                                                             |
   | ---------------------------------------- | -------------------------------------------------------------------- |
   | `GET /profit/<path>`                     | `PROFIT_API_BASE/api/<path>` (Bearer key)                            |
   | `POST /shopify/graphql`                  | `https://<SHOPIFY_STORE_DOMAIN>/admin/api/<version>/graphql.json`    |
   | `POST /skio/graphql`                     | `https://graphql.skio.com/v1/graphql`                                |
   | `GET /meta/<version>/<path>`             | `https://graph.facebook.com/<version>/<path>` (Bearer app token)     |
   | `POST /triplewhale/summary-page/get-data` | `https://api.triplewhale.com/api/v2/summary-page/get-data`          |

5. Upstream status, body and rate-limit / paging headers (`retry-after`, Meta throttle headers, `x-shopify-shop-api-call-limit`) pass straight back, so the kit clients' retry and pacing logic behaves as it does against the real API. The call is logged (`integrations/kit-gateway kit call`: service, path or GraphQL op, status, bytes, ms).
6. The script prints a formatted answer. Slow pulls are cached under `/home/app/workspace/cache/` (`kit/lib/cache.ts`; e.g. the Meta creatives pull) for follow-ups; deliverables go to `/home/app/output/` and out via `whatsapp_send_file`.

**Details worth knowing.**

- **Read-only by default.** Unless `JARVIS_KIT_ALLOW_WRITES=true`, GraphQL bodies are parsed with `graphql-js` and any mutation or subscription is refused (Shopify's `bulkOperationRunQuery` is allowed — it only exports a query); documents that don't parse are refused too; REST calls must be `GET`. Refusals are `403` with a message the agent can relay.
- **Shopify auth.** The gateway does the OAuth `client_credentials` exchange (`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`) and caches the token with an hour of headroom. Server errors in the exchange are retried; bad credentials fail at once as a `401` the kit client reports instead of retrying.
- **Meta paging.** `paging.next` URLs point at graph.facebook.com; `kit/lib/meta.ts` rewrites them onto the gateway.
- **Credentials are trimmed** on load (`core/env.ts`) — a CRLF-edited `.env` once broke Shopify and Triple Whale auth.
- **Local sandbox only.** The Deno provider can't reach the host's loopback and gets no kit env, so the `scandi-*` skills fail there with `Kit gateway is not available in this environment`. The rest of `/home/app/kit` still syncs.

## Tools and the registry

Every custom tool lives under `src/tools/<domain>/<name>.ts` and exports a LangChain `tool(...)`. They're collected in [`src/tools/registry.ts`](../src/tools/registry.ts), which is the single place to look up "what tools do we have?".

Agents reference tools by **string key** through `pickTools([...])`. This keeps agent definitions declarative and makes it trivial to surface the available tool surface in a future admin UI.

## Memory & state

LangGraph state (messages, todos, virtual files) is **per `thread_id`** with our default `MemorySaver`. The CLI assigns a thread per session; `/reset` rotates it. For long-term cross-thread memory, switch to a `StoreBackend` or pass `memory: [...]` to the agent definition (see DeepAgents [memory docs](https://docs.langchain.com/oss/javascript/deepagents/memory)).

Two important wrinkles when the sandbox is enabled:

- **Skill and kit files** live on host disk under `./skills/` and `./kit/` and are **shared globally** — every thread, every agent, every subagent sees the same files.
- **Sandbox filesystem** (anything the agent writes via `write_file("/home/app/...")`, `execute`, etc.) is **per process, not per thread**. The sandbox is a singleton, so files written in thread A (e.g. one WhatsApp chat) are visible to thread B. On the local provider `/home/app` also survives restarts (only `/tmp` is wiped on start). Namespace by `thread_id` in paths if you need isolation.

## Frontends

The `frontends/` directory at the repo root is reserved for future visualization / control-panel apps. Treat each frontend as its **own package** (its own `package.json`, build system, etc.) so React/Vite/Next tooling doesn't collide with the backend's TypeScript config. The agents can be exposed to those frontends via the `apps/` layer (e.g. an Express/Fastify server, or a LangGraph deployment).

### WhatsApp frontend (`src/apps/whatsapp/`)

The primary user-facing frontend today is **WhatsApp**, served by a Fastify webhook listener and an hourly summary-refresh worker. It uses the *same* `jarvis` agent the CLI uses, but composes it with:

- a small set of WA-aware tools (see [`src/tools/whatsapp/`](../src/tools/whatsapp/))
- a per-run `HumanMessage` context block: on a session's first run, chat header + rolling summaries + chat notes + the last 30 transcript messages + the triggering message; on later runs, only the messages since the previous run
- a per-chat state machine (debounce → run → optional hard-interrupt + restart, plus `/stop`) so that bursty user input doesn't spawn parallel runs
- bounded per-chat **sessions**: runs share `thread_id = <chat_jid>#<start time>` against a `PostgresSaver` checkpointer until the chat is idle 45 min or after 15 runs, keeping every model call small and prompt-cached
- a `wrapToolCall` middleware that bounds outbound WhatsApp calls per run

A separate Postgres schema (`jarvis.chat_context`, `jarvis.wa_webhook_seen`) holds the rolling daily / weekly / long-term summaries, chat notes (`whatsapp_remember`), and webhook idempotency keys. Summaries refresh in the background once a chat goes quiet after a run (never on the reply path), plus an optional hourly cron worker.

Full operational guide: [WHATSAPP.md](./WHATSAPP.md). Design history: [WHATSAPP_PLAN.md](./WHATSAPP_PLAN.md).

### Workflows (`src/workflows/`)

Sitting beside the chat agent is a small registry of **deterministic, no-LLM scheduled tasks** — daily expense reports, spreadsheet refreshes, etc. Each one is a `WorkflowDefinition` with a `run(ctx)` method; the shared CLI runner (`src/apps/workflows-cron.ts`) loads env, builds a `WhatsappClient`, calls `run`, and exits with a meaningful code. In production each workflow is wired to its own systemd `.timer`; the matching service template (`scandi-jarvis-workflow@.service`) is shared. Workflows use the same WA REST client the agent uses to post results back to chats. Operational guide: [WORKFLOWS.md](./WORKFLOWS.md).

## Configuration

All runtime config flows through [`src/core/env.ts`](../src/core/env.ts), which validates `process.env` with Zod and exposes a typed `env` object. Modules **must not** read `process.env` directly — that way every variable is documented in one place, and missing required values fail fast with a readable error.

## Observability

Set `LANGSMITH_TRACING=true` plus `LANGSMITH_API_KEY` in `.env` to send every run to [LangSmith](https://smith.langchain.com/). LangChain picks these up automatically — no code changes needed.
