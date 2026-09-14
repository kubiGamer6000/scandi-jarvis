# Development

A short cookbook for the most common things you'll do in this repo.

## Setup

```bash
nvm use                # Node 20+
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY at minimum
```

## Run

```bash
npm run chat                 # default agent (jarvis), terminal REPL
npm run chat -- jarvis       # explicit
npm run typecheck            # tsc --noEmit
npm run build                # compile to dist/
```

## Add a new tool

1. Pick a domain folder (or create one): `src/tools/<domain>/<name>.ts`.
2. Implement it:

   ```ts
   import { tool } from "langchain";
   import { z } from "zod";

   export const helloName = tool(
     ({ name }: { name: string }) => `Hello, ${name}!`,
     {
       name: "hello_name",
       description: "Greet someone by name.",
       schema: z.object({
         name: z.string().describe("Person to greet."),
       }),
     },
   );
   ```

3. Add it to the registry:

   ```ts
   // src/tools/registry.ts
   import { helloName } from "./greetings/hello-name.js";

   export const tools = {
     ...,
     helloName,
   } as const satisfies Record<string, StructuredTool>;
   ```

4. Document it in [`docs/TOOLS.md`](./TOOLS.md).
5. Opt an agent in via `pickTools(["helloName", ...])`.

For credentials, add the env var to [`src/core/env.ts`](../src/core/env.ts) **and** [`.env.example`](../.env.example), then read it via `env.MY_KEY` (or guard with `hasCredential("MY_KEY")`).

### Reuse a Composio toolkit instead of writing a tool

Before writing a hand-rolled tool, check whether [Composio](https://composio.dev) already has a toolkit for the service. If it does, you usually want it — it handles OAuth, token refresh and a stable API surface for free.

```ts
// src/agents/<name>/index.ts
export const definition: AgentDefinition = {
  ...,
  composio: {
    toolkits: ["GMAIL", "SLACK"],
    important: true, // only the curated subset
    limit: 50,
  },
};
```

`buildAgent()` resolves these at build time and merges them with the agent's local tools. See [`docs/TOOLS.md` → Composio toolkits](./TOOLS.md#composio-toolkits).

## Add a new agent

1. Create the folder:

   ```
   src/agents/<name>/
   ├── prompt.ts
   ├── tools.ts
   └── index.ts
   ```

2. `prompt.ts` — export a system prompt string.
3. `tools.ts` — pick tools by registry key:

   ```ts
   import { pickTools } from "../../tools/registry.js";
   export const myAgentTools = pickTools(["calculator", "getCurrentDatetime"]);
   ```

4. `index.ts` — declare and build:

   ```ts
   import { buildAgent, type AgentDefinition } from "../../core/agent.js";
   import { MY_AGENT_PROMPT } from "./prompt.js";
   import { myAgentTools } from "./tools.js";

   export const definition: AgentDefinition = {
     name: "my-agent",
     description: "What this agent is for.",
     systemPrompt: MY_AGENT_PROMPT,
     tools: myAgentTools,
   };

   export async function build() {
     return buildAgent(definition);
   }
   ```

5. Register it in [`src/agents/index.ts`](../src/agents/index.ts).
6. Document it in [`docs/AGENTS.md`](./AGENTS.md).
7. Run it: `npm run chat -- my-agent`.

## Add a new subagent

Use a subagent when a domain produces large / chatty output that would otherwise pollute the parent's context (the **Shopify** subagent is the canonical example), when you want a different tool set or model for a slice of work, or when you want to give a slice of work its own skill set.

1. Create the folder:

   ```
   src/subagents/<name>/
   ├── prompt.ts
   ├── tools.ts
   └── index.ts
   ```

2. `prompt.ts` — focused system prompt. Spell out the **report contract** the parent expects back; subagents do not inherit the parent's prompt.
3. `tools.ts` — minimal tool surface. Composio toolkits / specific slugs are fine here too.
4. `index.ts` — export a `SubAgentDefinition`:

   ```ts
   import type { SubAgentDefinition } from "../../core/agent.js";
   import { MY_SUBAGENT_PROMPT } from "./prompt.js";

   export const mySubagent: SubAgentDefinition = {
     name: "my-subagent",
     description: "Action-oriented description that drives delegation.",
     systemPrompt: MY_SUBAGENT_PROMPT,
     composio: { tools: ["..."] }, // or `tools: [...]` for local tools
     skillSets: ["my-subagent"],   // optional, see Skills below
   };
   ```

5. Register it on the parent agent's `definition.subagents`. `buildAgent` resolves Composio + skill paths automatically.
6. Document it in [`docs/AGENTS.md`](./AGENTS.md).

## Skills

Skills are reusable, on-demand capability bundles loaded via _progressive disclosure_ — the agent only reads a skill's body when the skill's frontmatter description matches the user's task. See the [DeepAgents Skills docs](https://docs.langchain.com/oss/javascript/deepagents/skills).

**Layout.** Each subdirectory of [`/skills/`](../skills/) is a **skill set** — a bundle of skill folders an agent can opt into:

```
skills/
├── jarvis/                  ← skill set for the main Jarvis agent (+ general-purpose subagent)
│   ├── docx/                Word .docx workflows + Python/JS tooling (executed via `execute` in sandbox)
│   └── pdf/                 PDF read/extract/merge/split/OCR/form-fill workflows + Python helpers
└── shopify/                 ← skill set for the shopify subagent
    ├── shopify-admin/       Admin GraphQL: docs search + schema validation
    │   ├── SKILL.md
    │   ├── scripts/         search_docs.mjs, validate.mjs (executed via `execute`)
    │   └── assets/          gzipped Admin GraphQL schema
    └── shopifyql/           ShopifyQL authoring guide
        ├── SKILL.md
        └── references/      syntax-reference.md, data-model.md, recipes.md, ...
```

A `SKILL.md` follows the [Agent Skills spec](https://agentskills.io/specification): YAML frontmatter (`name`, `description`, ...) followed by Markdown instructions. Scripts can be any runtime available in the sandbox — Node (`*.mjs`), bash, Python, etc. (on the local sandbox, the preinstalled Python packages and node modules come from `scripts/setup-sandbox.sh`). All skill files, including binary assets (`.gz`, `.png`, ...), are copied byte-for-byte by the skills-sync middleware (see `src/core/skills-sync.ts`).

**Wire-up.** Opt an agent or subagent in via `skillSets`:

```ts
// src/agents/jarvis/index.ts
export const definition: AgentDefinition = {
  ...,
  skillSets: ["jarvis"],
};

// src/subagents/shopify/index.ts
export const shopifySubagent: SubAgentDefinition = {
  ...,
  skillSets: ["shopify"],
};
```

`buildAgent` mounts the on-disk `skills/` folder at the agent's virtual path `/home/app/skills/` (via `FilesystemBackend(virtualMode: true)`). The agent sees skills at paths like `/home/app/skills/shopify/<skill>/SKILL.md`.

**Why `/home/app/skills/` and not `/skills/`?** When the sandbox is enabled (see below), files can only be uploaded to the writable areas `/home/app/...` and `/tmp/...` — that holds for both the local and the Deno provider. We use the same prefix in non-sandbox mode for consistency, so authoring is identical regardless of how the agent runs.

**Isolation.** Custom subagents do **not** inherit the parent's skill sets; they get only what they declare. The auto-attached `general-purpose` subagent does inherit the parent's skill sets.

## Sandbox (shell + executable skills)

Agents get the `execute` shell tool from a sandbox. Which one is picked by `JARVIS_SANDBOX_PROVIDER`:

| Provider          | What it is                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `local` (default) | Every `execute` runs under [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) on this machine. Free, no network hop. |
| `deno`            | A [Deno Deploy sandbox](https://docs.langchain.com/oss/javascript/integrations/providers/deno) (paid), with automatic failover to `local`. |
| `none`            | No sandbox — no shell, no script execution. Agents run on `StateBackend`.                                       |

`DENO_DEPLOY_TOKEN` doesn't enable anything on its own; it's only read when the provider is `deno`.

With a sandbox, every agent automatically gets:

- the sandbox as its default filesystem backend, which adds the `execute` tool
- a `beforeAgent` middleware that copies every file under `./skills/` into `/home/app/skills/...` in the sandbox, so an agent can `bash /home/app/skills/foo/run.sh` (or `python ...py`) on a script that ships with a skill. The copy is skipped when nothing under `./skills/` changed (paths + sizes + mtimes) since the last sync to the same provider.

**Local setup.** The local provider needs bubblewrap and a prebuilt toolchain. On Ubuntu 24.04:

```bash
sudo bash scripts/setup-sandbox.sh   # apt packages, AppArmor profile for bwrap, toolchain
npm run setup:sandbox                # (re)build only the toolchain, no sudo
```

The script installs `bubblewrap`, `python3-venv`, `poppler-utils`, `qpdf`, `pandoc`, `tesseract-ocr` (LibreOffice with `WITH_LIBREOFFICE=1`), adds `/etc/apparmor.d/bwrap` so `/usr/bin/bwrap` may create user namespaces (Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`), and builds a Python venv + `node_modules` (`docx`) under `<JARVIS_SANDBOX_DIR>/tools`. To add a Python package, append it to `PY_PACKAGES` in the script and rerun it.

**What the local sandbox looks like.** Each command gets fresh user/pid/ipc/uts/cgroup namespaces (network is shared unless `JARVIS_SANDBOX_NETWORK=false`) and this filesystem:

| Inside the sandbox | Host                              | Access                                   |
| ------------------ | --------------------------------- | ---------------------------------------- |
| `/usr`, `/etc`     | host                              | read-only                                |
| `/home/app`        | `<JARVIS_SANDBOX_DIR>/home`       | read-write, persistent                   |
| `/tmp`             | `<JARVIS_SANDBOX_DIR>/tmp`        | read-write, wiped when the process starts |
| `<dir>/tools`      | `<JARVIS_SANDBOX_DIR>/tools`      | read-only (venv + node_modules)          |

It can't see `/opt` (so not the repo or `.env`), host processes, or any Jarvis env var. A command that hits the timeout has its whole process tree killed (exit code `124`); output is capped, single-file size is limited (`ulimit -f`), and sandboxed processes get `oom_score_adj=1000` so a runaway command is OOM-killed before the Jarvis server. `uploadFiles` / `downloadFiles` run host-side with raw bytes, only under `/home/app` and `/tmp`, and refuse to follow symlinks out of those dirs.

**Deno provider.** [app.deno.com](https://app.deno.com) → Settings → Organization Tokens. Use an org token (`ddo_...`); personal tokens (`ddp_...`) additionally require `DENO_DEPLOY_ORG`. If Deno can't be provisioned, or its connection dies and can't be re-established, Jarvis falls back to `local` and tries Deno again after a 15-minute cooldown (at the start of a run, never mid-run). File transfer uses the Deno SDK's binary-safe `fs` API.

**Lifecycle.** One `JarvisSandbox` (extends deepagents' `BaseSandbox`) is created per Node process (`getSandbox()` in [`src/core/sandbox.ts`](../src/core/sandbox.ts)) and shared across all agents and subagents in that process. It's a stable object that swaps providers underneath, so a re-provisioned or failed-over sandbox never leaves an agent holding a dead handle. Entrypoints call `closeSandbox()` on exit. If no provider can start, `getSandbox()` logs `No sandbox provider could be started` and agents run without `execute`.

| Env var                           | Default     | Notes                                                                 |
| --------------------------------- | ----------- | --------------------------------------------------------------------- |
| `JARVIS_SANDBOX_PROVIDER`         | `local`     | `local` \| `deno` \| `none`.                                          |
| `JARVIS_SANDBOX_DIR`              | `.sandbox`  | Local sandbox state (`home/`, `tmp/`, `tools/`). Relative to cwd.     |
| `JARVIS_SANDBOX_EXEC_TIMEOUT_SEC` | `300`       | Per-command wall-clock limit (local). Min 5.                          |
| `JARVIS_SANDBOX_MAX_OUTPUT_BYTES` | `60000`     | Output returned to the agent is truncated beyond this (local).        |
| `JARVIS_SANDBOX_MAX_FILE_MB`      | `512`       | Max size of any single file a command writes (local).                 |
| `JARVIS_SANDBOX_NETWORK`          | `true`      | Outbound network from inside the local sandbox.                       |
| `JARVIS_SANDBOX_MAX_CONCURRENCY`  | `2`         | Local commands running at once; the rest queue.                       |
| `DENO_DEPLOY_TOKEN`               | _(unset)_   | `deno` provider only.                                                 |
| `DENO_DEPLOY_ORG`                 | _(unset)_   | Only required for personal (`ddp_`) tokens.                           |
| `JARVIS_SANDBOX_TIMEOUT`          | `session`   | Deno only. `"session"` = closes when this process disconnects. Or `"20m"`, `"1h"` for hard idle TTL. |
| `JARVIS_SANDBOX_MEMORY`           | `1GiB`      | Deno only. Min 768MiB, max 4GiB.                                      |

**Verify it works.**

```bash
npm run smoke:sandbox         # against the configured provider: execution, binary
                              # round-trip, skills sync, and (local) isolation checks
JARVIS_SANDBOX_EXEC_TIMEOUT_SEC=5 npm run smoke:sandbox   # also tests timeouts

npm run smoke:shopify-skill   # provisions + runs shopify-admin's
                              # search_docs.mjs and validate.mjs end-to-end
```

**Subagents inherit the sandbox.** The harness reuses the parent's backend, so once jarvis has a sandbox, the shopify subagent (and any future subagent) automatically gets the same `execute` tool and the same `/home/app/skills/...` mount.

**Binary files.** `whatsapp_pull_file` writes the downloaded media into the sandbox as raw bytes (`encoding: "raw"`), and `whatsapp_send_file` reads through `downloadFiles`, so `.pdf` / `.docx` / images round-trip intact. Without a sandbox, `whatsapp_pull_file` stores binaries base64-encoded in state.

**Known limits.**

- **One shared workspace.** `/home/app` is shared by every chat and thread in the process — files written during one chat's run are visible to runs in another.
- **Network is on by default.** Sandboxed code can reach the internet and services on the host's localhost (though it doesn't have the tokens they need). Set `JARVIS_SANDBOX_NETWORK=false` to cut it off.
- **Symlink race.** File transfer checks for symlinks before writing; a same-uid race between that check and the write is theoretically possible but requires concurrent `execute` calls.

## Add a new entrypoint (server, cron, Slack bot, …)

Drop a new file under `src/apps/`. It should:

- import the agent it wants from `src/agents/<name>/`
- call `await build()` once at startup
- call `agent.invoke({...}, { configurable: { thread_id } })` per request

Avoid putting business logic in the entrypoint — keep it in the agent definition or in a tool.

## WhatsApp frontend

The `src/apps/whatsapp/` app exposes Jarvis as a WhatsApp bot via [scandi-wa-bot](../../scandi-wa-bot/). See [`docs/WHATSAPP.md`](./WHATSAPP.md) for the operational doc, and [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) for putting it on the production droplet alongside the bot.

Quick start:

```bash
# 1. Fill in the WA + Postgres env vars in .env (see .env.example).
# 2. Apply the schema once on Supabase (the SQL lives in db/migrations/).
# 3. Run the server:
npm run wa:server

# Verify:
npm run smoke:wa-client         # checks /v1/health + /v1/me
npm run smoke:wa-dispatcher     # pure-logic state-machine assertions
npm run smoke:wa                # end-to-end: signed webhook → bot sees a reply
```

The `smoke:wa` script is deployable as a healthcheck — point it at the live `wa:server` and bot, and it will POST a canned trigger and assert that an agent reply lands on the bot within `JARVIS_WA_SMOKE_TIMEOUT_MS` (default 90s). See the script header for the full set of `JARVIS_WA_SMOKE_*` env vars.

### Summary cron worker

Daily / weekly summaries are refreshed lazily by the runner when they're stale, but a separate worker keeps them warm so user-facing runs rarely pay the cost:

```bash
# One-shot (deploy via cron / systemd timer hourly):
npm run wa:summarize-cron

# Or long-running (deploy via pm2 / supervisord):
LOOP=1 npm run wa:summarize-cron
```

Either deployment works against the same `jarvis.chat_context` table. A typical setup is the `wa:server` process running continuously plus the cron worker firing every hour. On the production droplet both run under systemd — see [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) §3-4.

## Workflows (deterministic cron tasks)

For scheduled tasks that don't need an LLM (daily expense report, spreadsheet refresh, etc.), use the workflow registry under `src/workflows/`. Each workflow is a `WorkflowDefinition` wired into the shared CLI runner.

```bash
npm run workflow:list                              # list every registered workflow
npm run workflow -- run revolut-daily-expenses     # run one locally
```

In production each workflow gets its own systemd `.timer`; the service unit (`scandi-jarvis-workflow@.service`) is shared. See [`docs/WORKFLOWS.md`](./WORKFLOWS.md) for the full guide on adding a new one and [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) §4b for the systemd plumbing.

## Add a frontend

Create a new package directory under `frontends/<app-name>/` with its own `package.json`, `tsconfig.json`, and build system (Vite/Next/etc.). Don't share the root `tsconfig.json` — frontends have a different module/runtime target. Talk to agents via an HTTP entrypoint in `src/apps/`, or via a [LangGraph deployment](https://docs.langchain.com/oss/javascript/deepagents/going-to-production).

## Tracing & debugging

Set in `.env`:

```
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=scandi-jarvis
```

Every run will then show up in [LangSmith](https://smith.langchain.com/) with the full message timeline, tool calls, and subagent traces.

## Conventions

- **Imports use `.js` extensions** even from `.ts` files (NodeNext + ESM).
- **Strict TS.** Don't disable `strict` per-file; fix the type instead.
- **No `process.env` outside `core/env.ts`.** Add the variable there with a Zod type and a default.
- **Tools are small and pure.** No reaching back into agents.
- **Docs are living.** When you add a tool / agent / app, update the matching `docs/*.md` row in the same PR.
