# frontends/

Reserved for future visualisation / control-panel apps (React, Vite, Next.js, …).

Conventions:

- **Each frontend is its own package.** Put it in `frontends/<app-name>/` with its own `package.json`, `tsconfig.json`, and build tooling. Do not share the root `tsconfig.json` — frontends and the backend have different module / runtime targets.
- **Talk to agents over HTTP.** Spin up an entrypoint in [`src/apps/`](../src/apps/) (e.g. an Express/Fastify server), or deploy the agent to [LangGraph Cloud](https://docs.langchain.com/oss/javascript/deepagents/going-to-production) and hit it from the frontend.
- **Don't import from `src/`.** Frontends should treat the backend as a black box behind an API. If you need shared types, generate them (e.g. zod-to-openapi → typescript) rather than reaching across the boundary.

This directory is excluded from the root `tsconfig.json` (`exclude: ["frontends"]`).
