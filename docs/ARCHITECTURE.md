# Architecture

Jarvis is intentionally small right now — but the layout is chosen so that it can grow into a multi-agent platform without restructuring later.

## Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/         CLI today; HTTP server / cron jobs / Slack bot later       │ ← entrypoints
├──────────────────────────────────────────────────────────────────────────┤
│ agents/       Each agent = folder { index, prompt, tools }               │ ← personalities
│ subagents/    Specialised, delegated-to agents with their own            │
│               prompt/tools/skills (e.g. `shopify-agent`)                 │
├──────────────────────────────────────────────────────────────────────────┤
│ tools/        Reusable tools, indexed in `registry.ts`                   │ ← capabilities
│ skills/       On-disk Agent-Skills bundles, opted into per (sub)agent    │
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

1. Resolves the model (default: `anthropic:claude-opus-4-6`, configurable via `JARVIS_MODEL`).
2. Loads any declared Composio tools (no-op if `COMPOSIO_API_KEY` is unset) and merges them with the local tools.
3. Resolves each subagent (its own tools, composio config, model, skill paths).
4. Picks a backend (see [Backends below](#backends-filesystem-and-shell)) and, when the sandbox is enabled, attaches a `beforeAgent` middleware that mirrors `./skills/` into the sandbox VM.
5. Calls `createDeepAgent({ name, model, tools, systemPrompt, subagents, backend, middleware, skills, checkpointer })`.
6. Returns the compiled LangGraph agent — so callers can use `.invoke`, `.stream`, etc.

## Subagents

Specialised subagents (separate from the harness's auto-attached `general-purpose` one) live under `src/subagents/<name>/` with the same `{ prompt, tools, index }` shape as agents — except the index exports a `SubAgentDefinition` instead of a full `AgentDefinition`. The parent agent declares them on `definition.subagents`; `buildAgent` resolves them and DeepAgents wires them into the parent's `task` tool.

Subagents **share the parent's backend instance** (so the same sandbox + skills mount), but their `messages` and `todos` are isolated — only the final string result of a `task` call bubbles back to the parent.

The canonical example is `shopify-agent`: it owns Shopify Admin GraphQL execution so the (often large) GraphQL transcripts and skill-script output stay out of jarvis's context. See [`docs/AGENTS.md`](./AGENTS.md) for the live inventory.

## Skills

`skills/<set>/<skill>/SKILL.md` are reusable, progressive-disclosure capability bundles. An agent or subagent opts into a skill set by name (`skillSets: ["shopify"]`); `buildAgent` mounts that set at the virtual path `/home/app/skills/<set>/`, and the DeepAgents skills middleware exposes each skill's `name` + `description` in the agent's system prompt. The full `SKILL.md` body is only read by the agent when the task matches.

See [`docs/DEVELOPMENT.md#skills`](./DEVELOPMENT.md#skills) for the layout and authoring rules.

## Backends (filesystem and shell)

`buildAgent` picks one of three backend topologies based on whether a sandbox is configured and whether any agent declared skill sets:

| `DENO_DEPLOY_TOKEN` | Skills declared? | Default backend | `/home/app/skills/` mounted at | `execute` (shell) tool |
| ------------------- | ---------------- | --------------- | ------------------------------ | ---------------------- |
| set                 | yes              | `DenoSandbox`   | `FilesystemBackend(./skills)`  | ✓                      |
| set                 | no               | `DenoSandbox`   | —                              | ✓                      |
| unset               | yes              | `StateBackend`  | `FilesystemBackend(./skills)`  | —                      |
| unset               | no               | `StateBackend` (DeepAgents default) | — | — |

When a sandbox is in play, a process-singleton `DenoSandbox` (see [`src/core/sandbox.ts`](../src/core/sandbox.ts)) is provisioned lazily on the first `buildAgent` call and shared across every agent and subagent in that Node process. A `beforeAgent` middleware (see [`src/core/skills-sync.ts`](../src/core/skills-sync.ts)) mirrors every file under `./skills/` into `/home/app/skills/...` in the VM before each invocation, so scripts shipped with a skill can be executed via `execute` at the same path the agent reads them from.

Detailed lifecycle, env vars, and cost notes: [`docs/DEVELOPMENT.md#sandbox-shell--executable-skills`](./DEVELOPMENT.md#sandbox-shell--executable-skills).

## Tools and the registry

Every custom tool lives under `src/tools/<domain>/<name>.ts` and exports a LangChain `tool(...)`. They're collected in [`src/tools/registry.ts`](../src/tools/registry.ts), which is the single place to look up "what tools do we have?".

Agents reference tools by **string key** through `pickTools([...])`. This keeps agent definitions declarative and makes it trivial to surface the available tool surface in a future admin UI.

## Memory & state

LangGraph state (messages, todos, virtual files) is **per `thread_id`** with our default `MemorySaver`. The CLI assigns a thread per session; `/reset` rotates it. For long-term cross-thread memory, switch to a `StoreBackend` or pass `memory: [...]` to the agent definition (see DeepAgents [memory docs](https://docs.langchain.com/oss/javascript/deepagents/memory)).

Two important wrinkles when the sandbox is enabled:

- **Skill files** live on host disk under `./skills/` and are **shared globally** — every thread, every agent, every subagent sees the same files.
- **Sandbox VM filesystem** (anything the agent writes via `write_file("/scratch/...")` etc.) is **per Node process, not per thread**. The sandbox is a singleton, so files written in thread A are visible to thread B until the process restarts. Namespace by `thread_id` in paths if you need isolation.

## Frontends

The `frontends/` directory at the repo root is reserved for future visualization / control-panel apps. Treat each frontend as its **own package** (its own `package.json`, build system, etc.) so React/Vite/Next tooling doesn't collide with the backend's TypeScript config. The agents can be exposed to those frontends via the `apps/` layer (e.g. an Express/Fastify server, or a LangGraph deployment).

### WhatsApp frontend (`src/apps/whatsapp/`)

The primary user-facing frontend today is **WhatsApp**, served by a Fastify webhook listener and an hourly summary-refresh worker. It uses the *same* `jarvis` agent the CLI uses, but composes it with:

- a small set of WA-aware tools (see [`src/tools/whatsapp/`](../src/tools/whatsapp/))
- a per-run `HumanMessage` context block built from chat header + rolling summaries + chat notes + the last 30 transcript messages + the triggering message (the WA history is **never** stored in LangGraph state — it's rebuilt fresh each turn)
- a per-chat state machine (debounce → run → optional hard-interrupt + restart, plus `/stop`) so that bursty user input doesn't spawn parallel runs
- `thread_id = chat.jid` against a `PostgresSaver` checkpointer for durable per-chat todos / scratch files / intermediate reasoning
- a `wrapToolCall` middleware that bounds outbound WhatsApp calls per run

A separate Postgres schema (`jarvis.chat_context`, `jarvis.wa_webhook_seen`) holds the rolling daily / weekly / long-term summaries, chat notes (`whatsapp_remember`), and webhook idempotency keys. Summaries refresh lazily on read and proactively from a standalone cron worker.

Full operational guide: [WHATSAPP.md](./WHATSAPP.md). Design history: [WHATSAPP_PLAN.md](./WHATSAPP_PLAN.md).

## Configuration

All runtime config flows through [`src/core/env.ts`](../src/core/env.ts), which validates `process.env` with Zod and exposes a typed `env` object. Modules **must not** read `process.env` directly — that way every variable is documented in one place, and missing required values fail fast with a readable error.

## Observability

Set `LANGSMITH_TRACING=true` plus `LANGSMITH_API_KEY` in `.env` to send every run to [LangSmith](https://smith.langchain.com/). LangChain picks these up automatically — no code changes needed.
