# WhatsApp Jarvis — system map

A short map of how the WhatsApp Jarvis is built and run, as found on 2026-11-10.
It covers the live droplet, not only the code. Secret values are never listed here,
only the variable names.

## Which folder is which

| Folder (under `~/Documents/scandi/`) | What it is |
|---|---|
| `jarvis-stack/scandi-jarvis/` | **The AI agent** (Jarvis). Same commit as production. Use this one. |
| `jarvis-stack/scandi-wa-bot/` | **The WhatsApp client** (bot + REST API + notify API). Same commit as production. Use this one. |
| `scandi-jarvis/`, `scandi-wa-bot/` (top level) | Older clones from July. Stale, don't edit or deploy from them. |

GitHub: `kubiGamer6000/scandi-jarvis`, `kubiGamer6000/scandi-wa-bot`. Neither has GitHub
Actions; deploys are manual.

## Where it runs

Everything runs on one DigitalOcean droplet: **`whatsapp-server`**, `64.227.37.221`.
SSH in as `scandi@64.227.37.221` (root login is closed). The `scandi` user can run
`systemctl` and `journalctl` on the `scandi-*` units without a password (sudoers rule).

| systemd unit | Folder on the droplet | Job |
|---|---|---|
| `scandi-wa-bot.service` | `/opt/scandi-wa-bot` | The WhatsApp account itself (Baileys). REST API on `127.0.0.1:8787`, public as `https://wa-api.scandigum.com` through Caddy. |
| `scandi-jarvis.service` | `/opt/scandi-jarvis` | The AI agent. Webhook server on `127.0.0.1:3000` (`POST /wa-webhook`, `GET /health`). |
| `scandi-revolut-expenses.service` | `/opt/scandi-revolut-expenses` | Revolut Business report API on `127.0.0.1:8080`. |
| `scandi-jarvis-cron.timer` | (runs Jarvis code) | Every hour: refreshes chat summaries. **Active.** |
| `scandi-jarvis-workflow-revolut-daily-expenses.timer` | (runs Jarvis code) | 00:01 nightly expense report. **Disabled on 2026-11-10**, see below. |

Deploying Jarvis: on the droplet, `cd /opt/scandi-jarvis && ./scripts/deploy.sh`
(git pull, build, restart `scandi-jarvis` only). It does not touch any timer or the
WhatsApp bot.

## How the WhatsApp client connects and keeps its session

- `scandi-wa-bot` uses **Baileys**, a WhatsApp Web protocol library. It is linked to
  the team's WhatsApp account like a WhatsApp Web device (QR / pairing code).
- The login session ("creds") is kept in **Postgres** (Supabase), not on disk
  (`src/auth.ts`, replaces Baileys' file-based auth). It survives restarts and redeploys.
- It reconnects by itself on short drops. If WhatsApp logs the device out, it exits
  and someone has to re-link it. Restarting the bot is normally safe but is the one
  thing that can trigger a re-link, so avoid it unless needed.
- It stores every chat, message and media item in Postgres (`wa.*` tables), uploads
  media to Firebase Storage, and transcribes or describes media with Gemini,
  ElevenLabs and LlamaParse.

## How messages reach the AI

1. A message arrives in WhatsApp, and the bot saves it and fires a signed webhook (HMAC) to
   Jarvis at `127.0.0.1:3000/wa-webhook`.
2. Jarvis checks the **access gate**: only approved people (`JARVIS_WA_ALLOWED_SENDERS`,
   currently 6) in approved chats (`JARVIS_WA_ALLOWED_CHATS`, currently 1).
3. A per-chat dispatcher waits briefly for more messages (debounce), then runs the
   agent. A new message mid-run can interrupt and restart it, and `/stop` cancels it.
4. The agent answers by calling WhatsApp tools that hit the bot's REST API (send,
   react, edit, send/pull file, and others). It shows "typing…" while it works.

## Model and tools

- Framework: LangChain / LangGraph **DeepAgents** (TypeScript).
- Main model: `JARVIS_MODEL=anthropic:claude-opus-5`. Summaries: `JARVIS_SUMMARY_MODEL=anthropic:claude-sonnet-5`.
- Tools: WhatsApp tools (`src/tools/whatsapp/`), web search (Tavily), math, time,
  Revolut expense reports (`src/tools/revolut/`), Composio (Shopify), and a sandboxed
  shell (`execute`, bubblewrap on the droplet).
- Skills (`skills/jarvis/`): docx, pdf, pptx, xlsx, Scandi brand and knowledge,
  Meta Ads, Profit API, Shopify, ShopifyQL, Skio. Live business data goes through a
  local "kit gateway" that holds the API keys so the sandbox never sees them.
- Personality and rules: `src/agents/jarvis/prompt.ts`.

## Memory and knowledge

- **Conversation state:** LangGraph checkpoints in Postgres (`langgraph.*` tables), one
  thread per chat session (`<chat_jid>#<start time>`).
- **Context per run:** chat header, daily/weekly/long-term summaries, chat notes
  (saved with the agent's "remember" tool), and the last 30 messages.
- **Summaries:** refreshed in the background after a chat goes quiet, and hourly by
  `scandi-jarvis-cron.timer`.
- **Knowledge:** static business docs in `kit/knowledge/` plus the skills folder.

## Scheduled jobs

| Job | Where | State |
|---|---|---|
| Hourly summary refresh | `scandi-jarvis-cron.timer` | Active, unchanged |
| Nightly Revolut expense report (00:01) | `scandi-jarvis-workflow-revolut-daily-expenses.timer` → `scandi-jarvis-workflow@revolut-daily-expenses.service` → `node dist/apps/workflows-cron.js run revolut-daily-expenses` | **Disabled 2026-11-10** |

The agent has **no tool to create its own schedules**. Its prompt tells people to "ask
Veli" for recurring tasks. There are no crontabs for `scandi`, and the Revolut API has
no scheduler of its own. Workflows are plain code in `src/workflows/`, and each needs
its own systemd timer installed by hand.

### The expense report: what was changed and how to turn it back on

Changed on the droplet (2026-11-10):

```bash
sudo systemctl stop scandi-jarvis-workflow-revolut-daily-expenses.timer
sudo systemctl disable scandi-jarvis-workflow-revolut-daily-expenses.timer
```

This removed the timer's link in `timers.target.wants`, so it won't start again after a
reboot or deploy. The unit files and the workflow code are left in place.

Changed in code (branch `disable-daily-expense-report`): the Jarvis prompt no longer
says it sends a nightly report. This only takes effect after a deploy.

To turn it back on:

```bash
ssh scandi@64.227.37.221
sudo systemctl enable scandi-jarvis-workflow-revolut-daily-expenses.timer
sudo systemctl start scandi-jarvis-workflow-revolut-daily-expenses.timer
systemctl list-timers | grep revolut        # should show next run at 00:01
```

…and revert the prompt change in `src/agents/jarvis/prompt.ts`. To send one report by
hand: `sudo systemctl start scandi-jarvis-workflow@revolut-daily-expenses.service`.

## Editor-platform notifications (same WhatsApp account)

- `scandi-wa-bot` has a send-only **Notify API**: `POST https://wa-api.scandigum.com/v1/notify`
  (docs: `scandi-wa-bot/docs/NOTIFY.md`). The editor app (Editor Games / scandi-platform)
  calls it with its own `wak_…` key ("notify" scope, rate-limited, only
  `/v1/notify` routes). It goes through the same Baileys socket, so it is the
  same WhatsApp number as Jarvis.
- Keys are managed on the droplet: `cd /opt/scandi-wa-bot && npm run api-key -- list`.
- Unaffected by any Jarvis change. It only depends on `scandi-wa-bot.service` being up.

## Where secrets live (names only)

- `/opt/scandi-jarvis/.env`: `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, `COMPOSIO_*`,
  `DENO_DEPLOY_TOKEN`, `WA_BOT_TOKEN`, `WA_WEBHOOK_SECRET`, `SUPABASE_DB_URL`,
  `REVOLUT_EXPENSES_API_KEY`, `SHOPIFY_CLIENT_*`, `SKIO_API_KEY`, `TRIPLEWHALE_API_KEY`,
  `META_APP_TOKEN`, `PROFIT_API_KEY`, plus non-secret config (`JARVIS_*`, `WA_BOT_BASE_URL`, …).
- `/opt/scandi-wa-bot/.env`: `DATABASE_URL`, `API_AUTH_TOKEN`, `GEMINI_API_KEY`,
  `ELEVENLABS_API_KEY`, `LLAMA_CLOUD_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_PATH` (file).
  Notify API keys are stored hashed in Postgres.
- `/opt/scandi-revolut-expenses/.env`: `REVOLUT_CLIENT_ID`, `REVOLUT_PRIVATE_KEY_PATH`
  (file), `REVOLUT_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`, `API_KEYS`.
- Local copies of `.env` sit in the laptop clones. They are git-ignored, so don't commit them.
