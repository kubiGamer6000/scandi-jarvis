# Tools

Custom tools live under `src/tools/<domain>/<name>.ts` and are indexed by stable string key in [`src/tools/registry.ts`](../src/tools/registry.ts).

> Built-in deepagents tools (`write_todos`, `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `task`) are added automatically by the harness — they don't appear here.
>
> The `execute` shell tool is added automatically too, but **only when the agent's backend is a sandbox**. With `JARVIS_SANDBOX_PROVIDER=local` (the default) or `deno`, every agent (and inherited subagents) gets it; with `none`, or if no sandbox provider could start, the agent runs on `StateBackend` and has no shell. See [DEVELOPMENT.md → Sandbox](./DEVELOPMENT.md#sandbox-shell--executable-skills).

## Active tools

| Registry key         | Source                                                            | Requires                                | What it does                                                                                                       |
| -------------------- | ----------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `getCurrentDatetime` | [`time/current-datetime.ts`](../src/tools/time/current-datetime.ts) | —                                       | Current date/time in any IANA timezone. Use before reasoning about "today", "this week", etc.                       |
| `calculator`         | [`math/calculator.ts`](../src/tools/math/calculator.ts)             | —                                       | Safe arithmetic evaluator (+ - * / % **, parens, sci notation, abs/sqrt/log/exp/trig, pi/e). No `eval()`.            |
| `internetSearch`     | [`web/internet-search.ts`](../src/tools/web/internet-search.ts)     | `TAVILY_API_KEY`                        | Web search via [Tavily](https://tavily.com/). Returns clear "not configured" error if the key is missing.          |
| `tavilyDeepResearch` | [`web/deep-research.ts`](../src/tools/web/deep-research.ts)         | `TAVILY_API_KEY`                        | [Tavily Research](https://tavily.com/) — multi-search synthesis, **model `pro`**, polled until done. Slower than search; optional structured `output_schema`. |

## Scandi data: skills, not tools

Business data (Profit API, Shopify, Skio, Meta Ads, Triple Whale) is **not** exposed as LangChain tools. The agent reads a `scandi-*` skill under `/home/app/skills/jarvis/` and runs its script with `execute` (e.g. `tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts summary --days 7`), or writes its own script against the clients in `/home/app/kit/lib/`. Output lands in the sandbox, so it can be cached, re-read and turned into files without passing through tool-call JSON.

Credentials never enter the sandbox: the clients call the host-side **kit gateway** ([`src/integrations/kit-gateway.ts`](../src/integrations/kit-gateway.ts)), which injects keys and refuses writes. That means these skills need `execute` on the **local** sandbox plus the service's env vars. Skill inventory: [`docs/AGENTS.md#skills`](./AGENTS.md#skills). Design: [`docs/ARCHITECTURE.md` → Scandi data](./ARCHITECTURE.md#scandi-data-kit-gateway).

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
    toolkits: ["GMAIL"],               // entire toolkits, OR …
    tools: ["<TOOLKIT>_<ACTION>"],     // specific tool slugs (see composio:list)
    important: true,                   // load only the curated subset (default true)
    limit: 50,                         // cap per toolkit (default 50)
  },
};
```

`buildAgent()` resolves these at agent-build time and merges them into the `tools` array. If `COMPOSIO_API_KEY` isn't set, the call **no-ops with a warning** so the agent still boots — handy when developing other parts of the system without a Composio key.

### Currently connected Composio tools

None. The loader stays as generic plumbing; no agent or subagent declares Composio tools today. (Shopify used to go through `SHOPIFY_GRAPH_QL_QUERY` on a `shopify-agent` subagent; that was replaced by the Scandi skills and kit gateway above.)

We tend to load **specific tool slugs** rather than entire toolkits — fewer, more flexible tools keep the agent's context lean while still covering the surface area we need. Heavy/chatty integrations are better scoped to a **subagent** so they don't bloat the parent's context.

To browse the full set of tools a toolkit exposes (handy when picking which slugs to enable):

```bash
npm run composio:list                  # default toolkit: SHOPIFY
npm run composio:list -- GMAIL SLACK   # multiple
```

### Adding another Composio capability

1. In the [Composio dashboard](https://platform.composio.dev), connect the integration for your `COMPOSIO_USER_ID` (default: `default`).
2. Decide whether you need:
   - **a single flexible tool** (preferred — e.g. a raw GraphQL/query executor if the toolkit has one). Add to `composio.tools`.
   - **a curated handful of tools** — list each slug in `composio.tools`.
   - **the whole toolkit** — only when the toolkit is small and you genuinely want all of it. Use `composio.toolkits` with `important: true` and a `limit`.
3. Update the agent's system prompt with usage hints / footguns specific to that tool (the model only sees the tool description by default — extra guidance about pagination, rate limits, mutation gotchas etc. should live in the prompt).
4. Run `npm run composio:list -- <TOOLKIT_SLUG>` to discover slugs.
5. Update the "Currently connected Composio tools" section above.

## Compose tools into an agent

```ts
import { pickTools } from "../../tools/registry.js";

export const myAgentTools = pickTools([
  "getCurrentDatetime",
  "calculator",
  "internetSearch",
  "tavilyDeepResearch",
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
