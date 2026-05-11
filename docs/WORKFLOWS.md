# Workflows — Operational Guide

Deterministic, no-LLM scheduled tasks that report results back via the
WhatsApp REST API. Distinct from the chat agent (`src/apps/whatsapp/`) and
from the summary cron — they share only the `WhatsappClient` and the env
loader.

Use these for any task that's:

- **scheduled** (daily / weekly / hourly), and
- **deterministic** — calls APIs, transforms data, posts a result. No
  model in the loop.

For "thinking" work that responds to a user prompt, use the chat agent.
For ad-hoc one-off tasks, just write a `scripts/*.ts`.

---

## 1. What's there today

| Workflow                 | What it does                                                                   | Schedule          | Destination                                               |
| ------------------------ | ------------------------------------------------------------------------------ | ----------------- | --------------------------------------------------------- |
| `revolut-daily-expenses` | Fetches yesterday's smart-mode HTML report from `scandi-revolut-expenses` and posts it to a chat (a short text + the HTML as a `document`). | `00:01` daily, Europe/Stockholm | `WORKFLOW_REVOLUT_CHAT_JID` (falls back to `JARVIS_WORKFLOWS_DEFAULT_CHAT_JID`). |

> The Revolut workflow expects the `scandi-revolut-expenses` API to be
> reachable on the loopback interface (default
> `REVOLUT_EXPENSES_API_BASE_URL=http://127.0.0.1:8080`). On the production
> droplet that means the `scandi-revolut-expenses.service` systemd unit
> must be installed and running — see
> [`scandi-revolut-expenses/docs/DEPLOYMENT.md`](../../scandi-revolut-expenses/docs/DEPLOYMENT.md).

---

## 2. Architecture

```
src/workflows/
  types.ts                          # WorkflowDefinition + WorkflowContext
  index.ts                          # registry: WORKFLOWS = [revolutDailyExpenses, …]
  revolut-daily-expenses/
    index.ts                        # the workflow
    client.ts                       # typed REST client for the expenses API
src/apps/
  workflows-cron.ts                 # CLI runner: `node dist/apps/workflows-cron.js run <name>`
```

Runtime model:

- **One CLI runner.** `workflows-cron.ts list` / `workflows-cron.ts run <name>`.
  Loads the env, builds a `WhatsappClient`, calls the workflow's `run(ctx)`,
  exits 0 / 1 / 2.
- **One systemd template service.** `scandi-jarvis-workflow@.service` (see
  `docs/DEPLOYMENT.md` §4b). The instance argument is the workflow name.
- **One timer per workflow.** `scandi-jarvis-workflow-<name>.timer`. Drop a
  new file, `daemon-reload`, `enable --now`, done.

Every workflow gets the same context:

```ts
interface WorkflowContext {
  wa: WhatsappClient;       // talks to the scandi-wa-bot REST API
  log: Logger;              // scoped: workflow/<name>
  signal: AbortSignal;      // tripped on SIGTERM / SIGINT
  startedAt: number;        // ms since epoch — use this for "report run timestamp"
}
```

---

## 3. Running locally

```bash
# List everything that's registered.
npm run workflow:list

# Run one. Reads .env from cwd; needs the same WA + workflow-specific vars
# as production.
npm run workflow -- run revolut-daily-expenses
```

The runner is a one-shot CLI — exits as soon as the workflow returns or
throws. Exit codes:

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | Workflow completed.                                                |
| 1    | Workflow threw, or required env was missing.                       |
| 2    | Usage error (no command / unknown workflow).                       |

---

## 4. Production schedule (recap of `docs/DEPLOYMENT.md` §4b)

```bash
# 1. Make sure the workflow's env vars are set.
sudo -u scandi nano /opt/scandi-jarvis/.env

# 2. Build (deploy script does this for you).
jarvis deploy

# 3. Drop a per-workflow .timer.
sudo nano /etc/systemd/system/scandi-jarvis-workflow-revolut-daily-expenses.timer

# 4. Enable.
sudo systemctl daemon-reload
jarvis workflow enable revolut-daily-expenses

# 5. Verify it's queued.
jarvis workflow next
```

Run it manually any time:

```bash
jarvis workflow run revolut-daily-expenses
jarvis workflow logs revolut-daily-expenses    # live tail
jarvis workflow tail revolut-daily-expenses 200
```

---

## 5. Adding a new workflow

End-to-end checklist for a new task. Pretend you want a
`profit-sheet-update` workflow that pokes the Google Sheets API at 00:05
daily.

### 5.1 Code

```bash
mkdir -p src/workflows/profit-sheet-update
```

`src/workflows/profit-sheet-update/index.ts`:

```ts
import { env } from "../../core/env.js";
import type { WorkflowDefinition } from "../types.js";

export const profitSheetUpdate: WorkflowDefinition = {
  name: "profit-sheet-update",
  description: "Refresh the profit Google sheet from yesterday's data.",
  async run(ctx) {
    const chatJid =
      env.WORKFLOW_PROFIT_CHAT_JID ?? env.JARVIS_WORKFLOWS_DEFAULT_CHAT_JID;
    if (!chatJid) throw new Error("destination chat not configured");

    // … your deterministic work here.
    // ctx.signal is tripped on SIGTERM — pass it to fetch / your client
    // so a deploy mid-run aborts cleanly.

    await ctx.wa.send(
      { to: chatJid, text: "Profit sheet updated!" },
      { signal: ctx.signal },
    );
  },
};
```

Register it in `src/workflows/index.ts`:

```ts
import { profitSheetUpdate } from "./profit-sheet-update/index.js";
…
export const WORKFLOWS: WorkflowDefinition[] = [
  revolutDailyExpenses,
  profitSheetUpdate,
];
```

### 5.2 Env vars

Add anything new to `src/core/env.ts` (Zod schema) and to
`.env.example`. The runner reads env via the same shared loader the
chat agent uses, so vars are validated at startup — typos surface
immediately.

```ts
// src/core/env.ts
WORKFLOW_PROFIT_CHAT_JID: z.string().optional(),
GOOGLE_SHEETS_SHEET_ID: z.string().optional(),
GOOGLE_SHEETS_SERVICE_ACCOUNT_PATH: z.string().optional(),
```

### 5.3 Schedule

`/etc/systemd/system/scandi-jarvis-workflow-profit-sheet-update.timer`:

```ini
[Unit]
Description=Daily profit sheet refresh

[Timer]
Unit=scandi-jarvis-workflow@profit-sheet-update.service
OnCalendar=*-*-* 00:05:00 Europe/Stockholm
Persistent=true
AccuracySec=30s
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
```

### 5.4 Deploy + enable

```bash
jarvis deploy
sudo systemctl daemon-reload
jarvis workflow enable profit-sheet-update
jarvis workflow run profit-sheet-update    # smoke immediately
jarvis workflow next                       # confirm scheduling
```

You only ever touch `.timer` files for scheduling — the
`scandi-jarvis-workflow@.service` template is shared.

---

## 6. Conventions

- **Naming.** Workflow `name` is lowercase, hyphenated, filesystem-safe.
  It's used as the systemd template instance and the npm subcommand.
- **No model calls.** That's what the chat agent is for. If you need
  classification mid-workflow, prefer a dedicated tiny `Anthropic` call
  inline (no DeepAgents) or precompute and cache.
- **Use the abort signal.** Pass `ctx.signal` to every fetch/HTTP/DB
  call so a deploy or `systemctl stop` doesn't leave half-finished work.
- **Throw on failure.** Don't swallow errors. The runner returns exit
  code 1 and systemd records it; `jarvis workflow status <name>` shows
  the last failure.
- **Be idempotent if possible.** Workflows can be re-run with
  `jarvis workflow run <name>` for backfills / debugging. Don't double-post
  to the same chat if you can avoid it (or include a date in the message
  so a duplicate is obvious).
- **Keep destination chats configurable.** Always: `WORKFLOW_<NAME>_CHAT_JID`
  → `JARVIS_WORKFLOWS_DEFAULT_CHAT_JID` → throw. Don't hardcode JIDs.
- **Long-running tasks: bump the unit's `TimeoutStartSec`.** Default in the
  template service is 5min, which covers most things; if a workflow
  legitimately takes longer, override per-timer with a `[Service]
  TimeoutStartSec=10min` in the `.timer` (it cascades).

---

## 7. Troubleshooting

| Symptom                                                              | Fix                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown workflow: <name>`                                           | Did you add it to `src/workflows/index.ts`? Did `jarvis deploy` run? `npm run workflow:list` confirms what's bundled in the build.        |
| `missing required env var: WA_BOT_BASE_URL`                          | The runner shares Jarvis's env file. If `/opt/scandi-jarvis/.env` is missing it, fix and rerun.                                           |
| `WORKFLOW_REVOLUT_CHAT_JID or JARVIS_WORKFLOWS_DEFAULT_CHAT_JID …`   | Set one of them in `.env`, restart the timer (timer doesn't reload env between fires; it picks the new one up on the next ExecStart).     |
| `RevolutExpenses GET /v1/report → 401: …`                            | `REVOLUT_EXPENSES_API_KEY` doesn't match the `API_KEYS` on the report server. Check whitespace/newlines.                                  |
| `RevolutExpenses … → 400: period=on requires &date=`                 | A workflow built its own query and forgot to set `date`. Fix and `jarvis workflow run <name>`.                                            |
| `request timeout` after exactly 60s                                  | Smart-mode cold cache + a brand new merchant. Bump `timeoutMs` on the client construction in the workflow if this is recurring.           |
| Timer fires but the message never arrives in WA                      | `jarvis workflow tail <name> 100` — look for a non-2xx from `whatsapp_send_message`. The `to` JID might not be in the bot's allowlist.    |
| Two messages on the same day                                         | A second timer fired (e.g. you ran `jarvis workflow run` after the auto fire). Workflows aren't dedupe'd by design; add idempotency.      |
| Timer enabled but `next` shows "n/a" / never                         | Did you `daemon-reload` after creating the `.timer`? Did the `.timer`'s `Unit=` line spell the workflow name correctly?                   |
| Smart report sometimes 30s, sometimes 60s+                           | Cold caches in the upstream API. Pre-warm by running the workflow once during the day so `data/merchants.json` is full by midnight.       |

### Quick diagnostic loop

```bash
jarvis workflow next                            # is it scheduled?
jarvis workflow status revolut-daily-expenses   # last fire result
jarvis workflow tail revolut-daily-expenses 100 # recent log lines
jarvis workflow run revolut-daily-expenses      # force a run, tail logs
```
