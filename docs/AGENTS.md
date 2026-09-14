# Agents

This is the living inventory of every agent in the project. Keep it short — one row per agent, link to the source for detail.

## Active

| Key      | Source                                        | Model (default)             | Tools                                                                | Subagents            | Skill sets         | Purpose                                                                                                            |
| -------- | --------------------------------------------- | --------------------------- | -------------------------------------------------------------------- | -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `jarvis` | [`src/agents/jarvis/`](../src/agents/jarvis/) | `anthropic:claude-opus-5`   | local: `getCurrentDatetime`, `calculator`, `internetSearch`, `tavilyDeepResearch`          | `general-purpose`\* | `jarvis`           | Scandi Gum operations assistant — live profit, MRR, Shopify, Skio and Meta numbers (via the `scandi-*` skills), research, documents and decks. Long multi-step analyses go to `general-purpose`.   |

\* `general-purpose` is auto-attached by the DeepAgents harness and inherits the parent's tools and skill sets.

There are no specialised subagents right now. (The former `shopify-agent`, which ran Shopify GraphQL through Composio, was replaced by the `scandi-shopify` / `shopify-admin` / `shopifyql` skills used directly by `jarvis`.)

## Skills

Each skill set lives at `skills/<set>/<skill>/SKILL.md`. They're loaded into the agent's system prompt via [DeepAgents progressive disclosure](https://docs.langchain.com/oss/javascript/deepagents/skills), so the agent only reads a skill's body when it's relevant. See [`skills/README.md`](../skills/README.md) and [`docs/DEVELOPMENT.md#skills`](./DEVELOPMENT.md#skills) for layout and authoring.

All skills below are in the `jarvis` set and used by `jarvis` and `general-purpose`\*. The `scandi-*` data skills run TypeScript scripts with `tsx` in the sandbox; they import the API clients in [`kit/lib/`](../kit/lib/) (mirrored to `/home/app/kit/`) and reach the APIs through the [kit gateway](./ARCHITECTURE.md#scandi-data-kit-gateway), so they need the **local** sandbox and the matching credentials. The system prompt routes questions to them (Profit API first) and sets the analysis non-negotiables.

| Skill               | What it provides                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `scandi-profit-api` | Profit, revenue, margin, COGS, MRR, subscriptions, blended ad spend, churn, data freshness from our dashboard API (`scripts/profit.ts`). The first stop for "how are we doing". |
| `scandi-shopify`    | Product / SKU sales, orders, customers, fulfilment, one-time vs subscription split (`scripts/query.ts`).                                        |
| `scandi-skio`       | Individual subscribers, billing schedules, cancellations and cancel-flow sessions, dunning and payment attempts (`scripts/skio.ts`).            |
| `scandi-meta-ads`   | Ad- and creative-level Meta performance: hooks, concepts, editors, video retention, CTR, ROAS (`scripts/creatives.ts`; Triple Whale reference). |
| `scandi-knowledge`  | Index into the business knowledge base (`kit/knowledge/`: products, metrics dictionary, profit model, MRR framings, ad naming, Editor Games, pitfalls). |
| `scandi-brand`      | Scandi visual identity (colours, Aeonik Pro, logo variants) for any deck, document, chart or visual that leaves the team.                          |
| `shopify-admin`     | Official Shopify skill: schema-aware Admin GraphQL authoring (`search_docs.mjs`) + offline validation (`validate.mjs`) against the bundled schema. |
| `shopifyql`         | ShopifyQL authoring guide for the `shopifyqlQuery` analytics endpoint — keyword order, time controls, recipes, GraphQL wiring.                  |
| `docx`              | Word (.docx) authoring, unpack/edit/repack, validation, Office helpers.                                                                         |
| `pdf`               | PDF workflows: text/table extraction, merge/split, rotation, watermarks, form fill, encrypt/decrypt, OCR, image extraction.                    |
| `xlsx`              | Spreadsheets (.xlsx/.csv) with formulas and formatting; recalculation via LibreOffice (`scripts/recalc.py`).                                    |
| `pptx`              | Slide decks: creating (pptxgenjs), reading and editing .pptx, thumbnails.                                                                       |

## Run an agent

```bash
npm run chat               # default (jarvis)
npm run chat -- jarvis     # explicit
tsx src/apps/cli.ts jarvis # equivalent
```

### Run an agent over WhatsApp

The same `jarvis` agent is exposed over WhatsApp via a Fastify webhook server. Each chat's runs share a session `thread_id` (`<chat_jid>#<start>`, rotated after 45 idle minutes or 15 runs), and the agent talks to the chat using WA-aware tools (`whatsapp_send_message`, `whatsapp_react`, `whatsapp_pull_file`, `whatsapp_send_file`, `whatsapp_fetch_messages`, `whatsapp_get_message`, `whatsapp_remember`, `whatsapp_edit_message`).

```bash
npm run wa:server               # webhook + agent loop
npm run wa:summarize-cron       # optional hourly rolling-summary refresh worker
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

The DeepAgents harness gives every agent a built-in `task` tool. The harness auto-attaches a `general-purpose` subagent (same prompt + tools + skill sets as the parent); on top of that you can declare **specialised** subagents on `definition.subagents`. None are declared today — `jarvis` delegates long analyses to `general-purpose` with a precise brief so raw data stays out of its context.

A specialised subagent lives in its own folder mirroring the agent layout:

```
src/subagents/<name>/
├── prompt.ts   focused system prompt + report contract
├── tools.ts    composio config / local tool selection
└── index.ts    exports a `SubAgentDefinition`
```

```ts
import type { SubAgentDefinition } from "../../core/agent.js";

export const mySubagent: SubAgentDefinition = {
  name: "my-subagent",
  description: "Action-oriented description that drives delegation…",
  systemPrompt: MY_SUBAGENT_PROMPT,
  tools: [/* local tools */],   // or composio: { tools: ["..."] }
  skillSets: ["my-subagent"],
};
```

`buildAgent` resolves each subagent's Composio tools and skill paths at build time, so the parent's `definition.subagents` is just a list of declarative configs.

When to reach for a specialised subagent (rather than `general-purpose`):
- a sub-task that needs a different tool set, prompt, or model
- a sub-task you want to give its own skill set (custom subagents don't inherit the parent's)
- a domain whose responses are large / chatty (web crawls, file transcripts) **and** needs its own rules — otherwise `general-purpose` already keeps that out of the main context
