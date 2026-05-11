# Jarvis

Jarvis is the in-house AI agent harness for **Scandi Gum**. It's a TypeScript project built on [LangChain](https://docs.langchain.com/oss/javascript/langchain/) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/) using the [DeepAgents](https://docs.langchain.com/oss/javascript/deepagents/overview) harness, designed to grow into a fleet of specialised agents that help us run the business: pulling data from Shopify and Meta Ads, generating reports, automating expense tracking, and so on.

The current default model is **Claude Opus 4.6** (`anthropic:claude-opus-4-6`).

## Quickstart

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env
# then put your ANTHROPIC_API_KEY (and optionally TAVILY_API_KEY) into .env

# 3. chat with the default Jarvis agent in your terminal
npm run chat
```

In the REPL, useful commands:

| Command   | What it does                                      |
| --------- | ------------------------------------------------- |
| `/reset`  | Start a fresh conversation thread (clears memory) |
| `/agents` | List every agent in the project                   |
| `/tools`  | List the tools the current agent has access to    |
| `/exit`   | Quit                                              |

## Visual debugger (Deep Agents UI)

Two terminals:

```bash
# terminal 1 – serve the agent over the LangGraph dev API
npm run dev:graph        # http://localhost:2024

# terminal 2 – Deep Agents UI (Next.js, vendored at frontends/deep-agents-ui)
npm run dev:ui           # http://localhost:3000
```

Open <http://localhost:3000> and connect with:

- **Deployment URL**: `http://localhost:2024`
- **Assistant ID**: `jarvis`
- **LangSmith API Key**: (optional, only needed for LangSmith-deployed graphs)

The graph entrypoint is [`src/langgraph.ts`](src/langgraph.ts), wired up via [`langgraph.json`](langgraph.json).

## Repo layout (high level)

```
src/
├── core/          shared building blocks (env, logger, model factory, agent factory)
├── tools/         reusable custom tools + a registry to compose them
├── agents/        each agent is a folder: prompt.ts + tools.ts + index.ts
└── apps/          runnable entrypoints (CLI today, server / etc. later)

docs/              short living docs (read these before extending the project)
frontends/         reserved for future React/visualization apps (own packages)
```

## Where to go next

| If you want to…                  | Read                                              |
| -------------------------------- | ------------------------------------------------- |
| Understand the design            | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)  |
| See what agents we have          | [`docs/AGENTS.md`](./docs/AGENTS.md)              |
| See what tools we have           | [`docs/TOOLS.md`](./docs/TOOLS.md)                |
| Add a new tool / agent / app     | [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)    |

## Scripts

| Script                  | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `npm run chat`          | Terminal REPL against the default agent                                |
| `npm run chat:jarvis`   | Same, explicit                                                         |
| `npm run smoke`         | Build every registered agent (no LLM call)                             |
| `npm run test:tools`    | Functional check of the standalone custom tools                        |
| `npm run composio:list` | List the Composio tools wired into a toolkit (default: `SHOPIFY`)      |
| `npm run typecheck`     | `tsc --noEmit` over the whole project                                  |
| `npm run build`         | Compile to `dist/`                                                     |
