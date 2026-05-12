# Agents

This is the living inventory of every agent in the project. Keep it short — one row per agent, link to the source for detail.

## Active

| Key      | Source                                        | Model (default)             | Tools                                                                | Subagents                            | Skill sets         | Purpose                                                                                                            |
| -------- | --------------------------------------------- | --------------------------- | -------------------------------------------------------------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `jarvis` | [`src/agents/jarvis/`](../src/agents/jarvis/) | `anthropic:claude-opus-4-6` | local: `getCurrentDatetime`, `calculator`, `internetSearch`, `tavilyDeepResearch`          | `shopify-agent`, `general-purpose`\* | _(none yet)_       | General-purpose Scandi Gum operations assistant — plans, researches, calculates, drafts. Delegates Shopify work.   |

\* `general-purpose` is auto-attached by the DeepAgents harness.

## Subagents

| Key             | Source                                                | Tools                              | Skill sets | Purpose                                                                                                                                                              |
| --------------- | ----------------------------------------------------- | ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shopify-agent` | [`src/subagents/shopify/`](../src/subagents/shopify/) | composio: `SHOPIFY_GRAPH_QL_QUERY` | `shopify`  | Authors and runs Shopify Admin GraphQL queries / mutations and ShopifyQL analytics queries. Leans on the `shopify-admin` and `shopifyql` skills. Returns a structured Markdown report. |

## Skills

Each skill set lives at `skills/<set>/<skill>/SKILL.md`. They're loaded into the agent's system prompt via [DeepAgents progressive disclosure](https://docs.langchain.com/oss/javascript/deepagents/skills), so the agent only reads a skill's body when it's relevant. See [`docs/DEVELOPMENT.md#skills`](./DEVELOPMENT.md#skills) for layout and authoring.

| Set       | Skill            | Used by         | What it provides                                                                                                                                |
| --------- | ---------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `shopify` | `shopify-admin`  | `shopify-agent` | Official Shopify skill: schema-aware GraphQL authoring (`search_docs.mjs`) + offline validation (`validate.mjs`) against the bundled Admin schema. |
| `shopify` | `shopifyql`      | `shopify-agent` | ShopifyQL authoring guide for the `shopifyqlQuery` analytics endpoint — keyword order, time controls, recipes, GraphQL wiring.                  |

## Run an agent

```bash
npm run chat               # default (jarvis)
npm run chat -- jarvis     # explicit
tsx src/apps/cli.ts jarvis # equivalent
```

### Run an agent over WhatsApp

The same `jarvis` agent is exposed over WhatsApp via a Fastify webhook server. Each chat gets its own `thread_id`, and the agent talks to the chat using WA-aware tools (`whatsapp_send_message`, `whatsapp_react`, `whatsapp_pull_file`, `whatsapp_send_file`, `whatsapp_fetch_messages`, `whatsapp_get_message`, `whatsapp_remember`, `whatsapp_edit_message`).

```bash
npm run wa:server               # webhook + agent loop
npm run wa:summarize-cron       # hourly rolling-summary refresh worker
```

See [WHATSAPP.md](./WHATSAPP.md) for the full operational guide and [WHATSAPP_PLAN.md](./WHATSAPP_PLAN.md) for the design history.

## Anatomy of an agent

```
src/agents/<name>/
├── prompt.ts   exports a system prompt string (the persona / rules)
├── tools.ts    picks tool keys from the registry
└── index.ts    exports `definition` + `build()`
```

The `definition` object (typed `AgentDefinition` in `src/core/agent.ts`) drives:
- the agent's name in logs and the registry
- which **local** tools, **Composio** tool slugs, and **subagents** it gets
- which **skill sets** to expose (subdirectories of [`/skills/`](../skills/) — see [`docs/DEVELOPMENT.md#skills`](./DEVELOPMENT.md#skills))
- model / temperature overrides (if any)
- whether memory is enabled (default: yes)

See [`docs/DEVELOPMENT.md`](./DEVELOPMENT.md#add-a-new-agent) for the step-by-step.

## Subagents (architecture)

The DeepAgents harness gives every agent a built-in `task` tool. The harness auto-attaches a `general-purpose` subagent (same prompt + tools as the parent); on top of that we declare **specialised** subagents on `definition.subagents`.

A specialised subagent lives in its own folder mirroring the agent layout:

```
src/subagents/<name>/
├── prompt.ts   focused system prompt + report contract
├── tools.ts    composio config / local tool selection
└── index.ts    exports a `SubAgentDefinition`
```

```ts
import type { SubAgentDefinition } from "../../core/agent.js";

export const shopifySubagent: SubAgentDefinition = {
  name: "shopify-agent",
  description: "Dedicated Shopify Admin GraphQL specialist…",
  systemPrompt: SHOPIFY_SUBAGENT_PROMPT,
  composio: { tools: ["SHOPIFY_GRAPH_QL_QUERY"] },
  skillSets: ["shopify"],
};
```

`buildAgent` resolves each subagent's Composio tools and skill paths at build time, so the parent's `definition.subagents` is just a list of declarative configs.

When to reach for a specialised subagent:
- a domain whose responses are large / chatty (Shopify GraphQL, web crawls, file transcripts) — keep that out of the main context
- a sub-task that needs a different tool set, prompt, or model
- a sub-task you want to give its own skill set
