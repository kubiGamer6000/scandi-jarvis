# Tools

Custom tools live under `src/tools/<domain>/<name>.ts` and are indexed by stable string key in [`src/tools/registry.ts`](../src/tools/registry.ts).

> Built-in deepagents tools (`write_todos`, `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `task`) are added automatically by the harness — they don't appear here.
>
> The `execute` shell tool is added automatically too, but **only when the agent's backend is a sandbox**. With `DENO_DEPLOY_TOKEN` set, every agent (and inherited subagents) gets it; without the token, the agent runs on `StateBackend` and has no shell. See [DEVELOPMENT.md → Sandbox](./DEVELOPMENT.md#sandbox-shell--executable-skills).

## Active tools

| Registry key         | Source                                                            | Requires                                | What it does                                                                                                       |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `getCurrentDatetime` | [`time/current-datetime.ts`](../src/tools/time/current-datetime.ts) | —                                       | Current date/time in any IANA timezone. Use before reasoning about "today", "this week", etc.                       |
| `calculator`         | [`math/calculator.ts`](../src/tools/math/calculator.ts)             | —                                       | Safe arithmetic evaluator (+ - * / % **, parens, sci notation, abs/sqrt/log/exp/trig, pi/e). No `eval()`.            |
| `internetSearch`     | [`web/internet-search.ts`](../src/tools/web/internet-search.ts)     | `TAVILY_API_KEY`                        | Web search via [Tavily](https://tavily.com/). Returns clear "not configured" error if the key is missing.          |

## Composio toolkits

[Composio](https://composio.dev) gives the agent access to 500+ pre-built integrations behind a single API key — they handle OAuth, token refresh, and the per-tool wiring. We use it for anything we don't want to hand-build a tool for.

The integration lives in [`src/tools/composio/`](../src/tools/composio/):

| File                | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `client.ts`         | Lazy singleton `Composio` client with the LangChain provider       |
| `loader.ts`         | `loadComposioTools(config)` – fetches + caches tools per request   |

An agent **or subagent** enables Composio tools declaratively in its `definition` via the same shape:

```ts
export const definition: AgentDefinition = {
  // …,
  composio: {
    toolkits: ["SHOPIFY"],            // entire toolkits, OR …
    tools: ["SHOPIFY_GRAPH_QL_QUERY"], // specific tool slugs
    important: true,                   // load only the curated subset (default true)
    limit: 50,                         // cap per toolkit (default 50)
  },
};
```

`buildAgent()` resolves these at agent-build time and merges them into the `tools` array. If `COMPOSIO_API_KEY` isn't set, the call **no-ops with a warning** so the agent still boots — handy when developing other parts of the system without a Composio key.

### Currently connected Composio tools

We tend to load **specific tool slugs** rather than entire toolkits — fewer, more flexible tools keep the agent's context lean while still covering the surface area we need. Tools are also typically scoped to a **subagent** rather than the main agent, so heavy/chatty integrations don't bloat the parent's context.

| Tool slug                | Toolkit | Used by                  | Auth                                  | Notes                                                                                       |
| ------------------------ | ------- | ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SHOPIFY_GRAPH_QL_QUERY` | SHOPIFY | `shopify-agent` subagent | OAuth or API key, managed in Composio | Raw Shopify Admin GraphQL executor — covers products, orders, customers, inventory, metafields, etc. through one flexible tool. |

To browse the full set of tools a toolkit exposes (handy when picking which slugs to enable):

```bash
npm run composio:list                  # default: SHOPIFY
npm run composio:list -- SHOPIFY GMAIL # multiple
```

### Adding another Composio capability

1. In the [Composio dashboard](https://platform.composio.dev), connect the integration for your `COMPOSIO_USER_ID` (default: `default`).
2. Decide whether you need:
   - **a single flexible tool** (preferred — e.g. `SHOPIFY_GRAPH_QL_QUERY`, `META_ADS_GRAPHQL_QUERY` if available, etc.). Add to `composio.tools`.
   - **a curated handful of tools** — list each slug in `composio.tools`.
   - **the whole toolkit** — only when the toolkit is small and you genuinely want all of it. Use `composio.toolkits` with `important: true` and a `limit`.
3. Update the agent's system prompt with usage hints / footguns specific to that tool (the model only sees the tool description by default — extra guidance about pagination, rate limits, mutation gotchas etc. should live in the prompt).
4. Run `npm run composio:list -- <TOOLKIT_SLUG>` to discover slugs.
5. Update the "Currently connected Composio tools" table above.

## Compose tools into an agent

```ts
import { pickTools } from "../../tools/registry.js";

export const myAgentTools = pickTools([
  "getCurrentDatetime",
  "calculator",
  "internetSearch",
]);
```

`pickTools` is fully typed against the registry, so a typo on a tool name is a compile error.

## Adding a tool

1. Create `src/tools/<domain>/<name>.ts`. Use `tool(...)` from `langchain` with a Zod schema.
2. Read any required credentials via `import { env, hasCredential } from "../../core/env.js"`. Add new env vars to `src/core/env.ts` and document them in `.env.example`.
3. Register it in [`src/tools/registry.ts`](../src/tools/registry.ts) under a clear key.
4. Add a row to the table above.
5. (Optional) opt your agent into it via `pickTools([...])`.

### Tool authoring rules

- **Schema first.** Every tool argument has a Zod type with `.describe(...)` so the model knows when and how to use it.
- **Strings in, strings out.** Return a `string` (typically `JSON.stringify({...})`) so token accounting is predictable and the model can re-read your output cheaply.
- **Fail soft.** If a credential or upstream is missing, return a structured `{ ok: false, error: "..." }` payload instead of throwing — that way the model can recover or surface the issue to the user.
- **Don't depend on agents.** Tools live below agents in the dependency graph (`tools/` → `core/`). They should be reusable across multiple agents.
