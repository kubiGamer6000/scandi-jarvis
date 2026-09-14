# skills/

Drop-in [Agent Skills](https://agentskills.io/) for Jarvis agents and subagents.

Each subdirectory is a **skill set**. An agent enables a skill set by name in its definition (`skillSets: ["jarvis"]`); `buildAgent` maps that to the virtual path `/home/app/skills/<set>/` inside the agent's filesystem. Today there is one set, `jarvis`, used by the main agent and inherited by the built-in `general-purpose` subagent.

```
skills/
└── jarvis/
    ├── scandi-profit-api/   Profit API: profit, margin, MRR, churn, blended spend (scripts/profit.ts)
    ├── scandi-shopify/      Orders, product sales, customers via Admin GraphQL + ShopifyQL (scripts/query.ts)
    ├── scandi-skio/         Subscribers, cancel reasons, billing attempts (scripts/skio.ts)
    ├── scandi-meta-ads/     Creative / hook / editor performance, per-ad spend (scripts/creatives.ts)
    ├── scandi-knowledge/    Index into the business knowledge base at /home/app/kit/knowledge/
    ├── scandi-brand/        Visual identity (colours, Aeonik Pro, logo, pattern) for anything that leaves the team
    ├── shopify-admin/       Official Shopify skill: Admin GraphQL docs search + schema validation
    ├── shopifyql/           ShopifyQL authoring guide (syntax, data model, recipes)
    ├── docx/                Word documents
    ├── pdf/                 PDF read / extract / merge / split / OCR / forms
    ├── xlsx/                Spreadsheets (LibreOffice recalculation)
    └── pptx/                Slide decks
```

A skill is a folder containing a `SKILL.md` (with YAML frontmatter `name`, `description`, …) plus any optional supporting files (templates, references, executable scripts).

## The Scandi kit (`../kit/`)

The `scandi-*` skills are thin CLIs over a shared toolkit that lives next to this folder, not inside it:

```
kit/
├── lib/         API clients: profitApi, shopify, skio, meta, triplewhale, plus fx, http, cache, args, creativeName, env
└── knowledge/   01-business-overview.md … 08-pitfalls.md, 09-other-apis.md
```

It is mirrored into the sandbox at `/home/app/kit/` by the same sync as the skills. Skill scripts are TypeScript run with `tsx` and import the clients by absolute path (`import { summary } from '/home/app/kit/lib/profitApi.ts'`).

The clients hold **no credentials**. Every call goes to the Jarvis kit gateway (`KIT_GATEWAY_URL`, token in `KIT_GATEWAY_TOKEN`), which attaches the real keys host-side and refuses writes. That gateway only exists next to the **local** sandbox; on the Deno provider, or with no Scandi credentials configured, a kit call fails with `Kit gateway is not available in this environment`. See [`docs/ARCHITECTURE.md` → Scandi data](../docs/ARCHITECTURE.md#scandi-data-kit-gateway).

Sandbox conventions the kit relies on:

- Pull caches go in `/home/app/workspace/cache/` (`kit/lib/cache.ts`).
- Files for a human go in `/home/app/output/` and get sent with `whatsapp_send_file`.
- `/home/app/package.json` (`"type": "module"`) and `/home/app/node_modules` (a symlink to the toolchain) are created at sandbox start so ESM scripts resolve preinstalled packages.

## How files are surfaced to the agent

`buildAgent` looks at whether a sandbox is available (`JARVIS_SANDBOX_PROVIDER` = `local` (default) or `deno`, and the provider started) and picks one of two wirings:

- **Sandbox enabled**:
  - default backend = `JarvisSandbox` (gives the agent the `execute` shell tool)
  - `/home/app/skills/` route = `FilesystemBackend(./skills, virtualMode: true)` (cheap reads of `SKILL.md` from host disk)
  - a `beforeAgent` middleware copies every file under `./skills/` to `/home/app/skills/...` and `./kit/` to `/home/app/kit/...` inside the sandbox so scripts can actually run (each skipped when nothing in it changed since the last sync)
- **Sandbox disabled** (`JARVIS_SANDBOX_PROVIDER=none`, or no provider could start):
  - default backend = `StateBackend` (ephemeral, no shell)
  - `/home/app/skills/` route = `FilesystemBackend(./skills, virtualMode: true)` (read-only access to `SKILL.md`)
  - scripts will be readable but **cannot be executed** without a sandbox, and `/home/app/kit/` isn't there

The path the agent sees is identical in both cases (`/home/app/skills/<set>/<skill>/...`), so authoring stays the same regardless of how it's deployed.

## Authoring tips

- Point to scripts by their absolute virtual path in `SKILL.md`, e.g. `tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts` or `bash /home/app/skills/jarvis/my-skill/run.sh`. The sync marks `.sh`/`.py`/`.mjs`/`.js`/`.cjs` files executable, so scripts with a shebang can also be run directly (`.ts` files are run with `tsx`).
- For Scandi data, import the clients from `/home/app/kit/lib/` rather than calling APIs by hand — they carry the retry, pacing and pagination the APIs need. Parse flags with `kit/lib/args.ts`: unknown flags are a hard error, so a guessed flag fails loudly instead of silently returning the default range.
- Reference any supporting file from `SKILL.md` so the agent knows when to read or run it (per the [Agent Skills spec](https://agentskills.io/specification)).
- Keep skill descriptions specific — that's what the agent matches on at progressive-disclosure time.

For example skills, see <https://github.com/langchain-ai/deepagentsjs/tree/main/examples/skills>.
