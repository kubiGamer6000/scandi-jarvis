# skills/

Drop-in [Agent Skills](https://agentskills.io/) for Jarvis agents and subagents.

Each subdirectory is a **skill set**. An agent enables a skill set by name in its definition (`skillSets: ["jarvis"]`); `buildAgent` maps that to the virtual path `/home/app/skills/<set>/` inside the agent's filesystem.

```
skills/
├── jarvis/                  ← skill set for jarvis (empty for now)
└── shopify/                 ← skill set for the shopify-agent subagent
    ├── shopify-admin/       Admin GraphQL: schema-aware authoring + validation
    │   ├── SKILL.md
    │   ├── scripts/         search_docs.mjs, validate.mjs
    │   └── assets/          gzipped Admin GraphQL schema
    └── shopifyql/           ShopifyQL authoring for `shopifyqlQuery` analytics
        ├── SKILL.md
        └── references/      syntax-reference.md, data-model.md, recipes.md, ...
```

A skill is a folder containing a `SKILL.md` (with YAML frontmatter `name`, `description`, …) plus any optional supporting files (templates, references, executable scripts).

## How files are surfaced to the agent

`buildAgent` looks at whether `DENO_DEPLOY_TOKEN` is set and picks one of two wirings:

- **Sandbox enabled** (token set):
  - default backend = `DenoSandbox` (gives the agent the `execute` shell tool)
  - `/home/app/skills/` route = `FilesystemBackend(./skills, virtualMode: true)` (cheap reads of `SKILL.md` from host disk)
  - a `beforeAgent` middleware uploads every file under `./skills/` to `/home/app/skills/...` inside the sandbox so executable scripts can actually run
- **Sandbox disabled** (no token):
  - default backend = `StateBackend` (ephemeral, no shell)
  - `/home/app/skills/` route = `FilesystemBackend(./skills, virtualMode: true)` (read-only access to `SKILL.md`)
  - scripts will be readable but **cannot be executed** without a sandbox

The path the agent sees is identical in both cases (`/home/app/skills/<set>/<skill>/...`), so authoring stays the same regardless of how it's deployed.

## Authoring tips

- Make scripts executable on disk (`chmod +x run.sh`) and point to them by their absolute virtual path in `SKILL.md`, e.g. `bash /home/app/skills/jarvis/my-skill/run.sh`.
- Reference any supporting file from `SKILL.md` so the agent knows when to read or run it (per the [Agent Skills spec](https://agentskills.io/specification)).
- Keep skill descriptions specific — that's what the agent matches on at progressive-disclosure time.

For example skills, see <https://github.com/langchain-ai/deepagentsjs/tree/main/examples/skills>.
