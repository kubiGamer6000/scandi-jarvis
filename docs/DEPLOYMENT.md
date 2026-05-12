# Deployment — DigitalOcean droplet (alongside `scandi-wa-bot`)

End-to-end guide for running **`scandi-jarvis`** on the same Ubuntu droplet
that already hosts `scandi-wa-bot`. Production-ready: systemd-supervised,
journald logs, atomic deploys, optional summary-cron timer, helper shell
function (`jarvis ...`) for daily ops.

Like the bot, the agent itself is **stateless on disk** — every byte that
matters (chat context, summaries, AGENTS.md-style notes, LangGraph
checkpoints) lives in the same Supabase Postgres database. The droplet
just runs the Node process; if it dies, rebuild from this guide and
`git clone` and you're back in minutes.

What runs in a single Node process (`dist/apps/whatsapp/server.js`):

- Fastify HTTP server on `127.0.0.1:3000`, route `POST /wa-webhook`
- Per-chat dispatcher state machine (debounce → run → optional
  hard-interrupt + restart) backed by an in-memory `p-queue`
- The shared `jarvis-whatsapp` DeepAgent (Anthropic + Composio +
  optional Deno sandbox), checkpointed per chat to `langgraph.*` tables
  in Supabase via `PostgresSaver`

Optional sidecar:

- `scandi-jarvis-cron.timer` — fires `dist/apps/whatsapp/summarize-cron.js`
  every hour to refresh daily/weekly summaries proactively.

**Assumptions:** you have already followed `scandi-wa-bot`'s
`docs/DEPLOYMENT.md` §§1-8 on this droplet. Host hardening, `scandi`
user, Node 20, swap, fail2ban, ufw, and the bot itself are already in
place. This doc only covers what's new for Jarvis.

> **Sibling service: `scandi-revolut-expenses`.** The Revolut daily
> expenses workflow ([`docs/WORKFLOWS.md`](./WORKFLOWS.md)) calls a
> separate HTTP API that lives in its own repo and runs on the same
> droplet as a third systemd unit. Deploy it per
> [`scandi-revolut-expenses/docs/DEPLOYMENT.md`](../../scandi-revolut-expenses/docs/DEPLOYMENT.md)
> before enabling the workflow timer in §4b — otherwise the run will
> fail with `fetch failed` against `127.0.0.1:8080`.

---

## 1. Prerequisites already on the droplet

| From the wa-bot deployment   | What we reuse                                                              |
| ---------------------------- | -------------------------------------------------------------------------- |
| Ubuntu 24.04 + hardening     | Same host.                                                                 |
| `scandi` user + ssh keys     | Same user runs both services.                                              |
| Node 20 (NodeSource)         | `/usr/bin/node` works for both.                                            |
| `psql` (postgresql-client)   | For applying Jarvis's one migration to the same Supabase DB.               |
| ufw + DO Cloud Firewall      | No new inbound ports needed — Jarvis talks to the bot via `127.0.0.1`.     |
| systemd + journald + Caddy   | Jarvis adds its own unit; doesn't touch Caddy.                             |

Nothing new in the firewall: the bot delivers webhooks to Jarvis over
the loopback interface (`http://127.0.0.1:3000/wa-webhook`), and Jarvis
talks back to the bot over the loopback interface too
(`http://127.0.0.1:8787`).

---

## 2. Outbound network requirements

Outbound 443 to:

- `api.anthropic.com` — model calls
- `backend.composio.dev` (or wherever your Composio org lives) — Shopify
  tool execution
- `*.supabase.co` — Postgres (same as the bot)
- `*.deno.com` / `*.deno.dev` — Deno sandbox provisioning + RPC (only if
  `DENO_DEPLOY_TOKEN` is set)
- `api.smith.langchain.com` — LangSmith tracing (only if
  `LANGSMITH_TRACING=true`)

All already allowed by the bot's outbound-any rule.

---

## 3. Install the app

### 3.1 Clone

```bash
sudo mkdir -p /opt/scandi-jarvis
sudo chown scandi:scandi /opt/scandi-jarvis

# As scandi:
cd /opt
sudo -u scandi git clone https://github.com/<you>/scandi-jarvis.git
cd scandi-jarvis

# Full deps (devDeps are needed for tsc).
sudo -u scandi npm ci

# TS → JS into ./dist
sudo -u scandi npm run build
```

> Note on `npm prune --omit=dev`: don't run this. The summary-cron
> reads from the same `dist/` and we keep `tsx` around for one-shot
> scripts. The total `node_modules` footprint is ~500 MB; not worth
> trimming.

### 3.2 `.env`

```bash
cd /opt/scandi-jarvis
sudo -u scandi cp .env.example .env
sudo -u scandi nano .env
sudo chmod 600 .env
sudo chown scandi:scandi .env
```

Required vars (everything else has sensible defaults — see `.env.example`):

| Var                       | Notes                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Model calls. Get from <https://console.anthropic.com>.                                      |
| `WA_BOT_BASE_URL`         | `http://127.0.0.1:8787` — the bot's local API (same droplet).                               |
| `WA_BOT_TOKEN`            | **Same value** as the bot's `API_AUTH_TOKEN` (`/opt/scandi-wa-bot/.env`).                   |
| `WA_WEBHOOK_SECRET`       | Generate with `openssl rand -hex 32`. We'll register it with the bot in §6.                 |
| `SUPABASE_DB_URL`         | Same Supabase pooler URI the bot uses (port 6543). Jarvis owns its own `jarvis.*` schema.   |
| `JARVIS_WA_ALLOWED_CHATS` | `*` to allow every chat, or a comma-separated whitelist of chat JIDs. Fail-closed by default. |
| `JARVIS_WA_HOST`          | `127.0.0.1` (default). **Do not** bind to `0.0.0.0` — we never expose Jarvis publicly.      |
| `JARVIS_WA_PORT`          | `3000` (default).                                                                           |

Recommended optional vars:

| Var                                                            | Why                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DENO_DEPLOY_TOKEN` (+ `DENO_DEPLOY_ORG` for personal tokens)  | Adds the `execute` shell tool + lets skill scripts run. Strongly recommended.         |
| `COMPOSIO_API_KEY` / `COMPOSIO_USER_ID`                        | Required for the Shopify subagent.                                                    |
| `TAVILY_API_KEY`                                               | Enables Tavily `internet_search` and `tavily_deep_research` (without it both return an error string). |
| `LANGSMITH_TRACING=true` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` | Trace every run in <https://smith.langchain.com>. Cheap and worth it.            |
| `LOG_LEVEL`                                                    | `info` in prod, `debug` while debugging.                                              |

> The `scandi-jarvis` env loader uses Zod and will **refuse to start**
> if any required var is missing — you'll see a clear `Invalid
> environment configuration` error in the journal.

### 3.3 Apply the migration

Jarvis owns one migration that lives in its own Postgres schema
(doesn't touch the bot's `wa.*` tables):

```bash
cd /opt/scandi-jarvis
psql "$(grep ^SUPABASE_DB_URL= .env | cut -d= -f2-)" \
  -f db/migrations/001_jarvis_init.sql
```

That creates:

- `jarvis.chat_context` — per-chat summaries (daily / weekly / longterm)
  + AGENTS.md-style notes written by `whatsapp_remember`.
- `jarvis.wa_webhook_seen` — webhook idempotency table (24h TTL).

The `langgraph.checkpoints` table is created automatically by
`PostgresSaver.setup()` on the first server boot — no separate migration.

### 3.4 systemd unit — main server

Create `/etc/systemd/system/scandi-jarvis.service`:

```ini
[Unit]
Description=scandi-jarvis — WhatsApp agent (Fastify webhook + DeepAgents)
After=network-online.target scandi-wa-bot.service
Wants=network-online.target
# We don't *strictly* require the bot to be up (the agent will fail
# preflight if it can't reach :8787) — but starting after it is tidier.
PartOf=scandi-wa-bot.service

[Service]
Type=simple
User=scandi
Group=scandi
WorkingDirectory=/opt/scandi-jarvis
EnvironmentFile=/opt/scandi-jarvis/.env
ExecStart=/usr/bin/node dist/apps/whatsapp/server.js

# Auto-restart on any exit. We exit non-zero on fatal preflight failure
# (missing env, DB down, bot unreachable) so a restart loop here either
# self-heals or is loud enough to investigate.
Restart=always
RestartSec=5

# Don't restart-storm if something's catastrophically broken.
StartLimitIntervalSec=300
StartLimitBurst=10

# Run unprivileged + sandboxed.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/scandi-jarvis
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true

# Resource limits — Anthropic responses can be chunky and the Deno sandbox
# RPC stays in-process. 1.5G is plenty headroom.
MemoryMax=1500M
TasksMax=512

# Logs go to journald.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=scandi-jarvis

[Install]
WantedBy=multi-user.target
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable scandi-jarvis
sudo systemctl start  scandi-jarvis
sudo systemctl status scandi-jarvis --no-pager
```

You should see something like:

```
[…] INFO  apps/whatsapp/server starting WhatsApp app {"port":3000,"host":"127.0.0.1"}
[…] INFO  apps/whatsapp/server preflight: env OK {"allowed_chats":-1}
[…] INFO  apps/whatsapp/server preflight: postgres OK
[…] INFO  apps/whatsapp/server preflight: WA bot OK {"status":"ok","sock_connected":true,…}
[…] INFO  apps/whatsapp/server WA identity {"account_id":"…","pn_jid":"…","lid_jid":"…","push_name":"Jarvis",…}
[…] INFO  apps/whatsapp/server langgraph checkpoints: setup OK
[…] INFO  apps/whatsapp/server listening on http://127.0.0.1:3000
```

### 3.5 Passwordless restart / status / logs

Mirror the wa-bot's sudoers rule. **Edit (don't replace) the existing
file** so both services share one entry:

```bash
sudo visudo -f /etc/sudoers.d/scandi-deploy
```

Make it look like:

```
scandi ALL=(root) NOPASSWD: /bin/systemctl start scandi-wa-bot, \
                            /bin/systemctl stop scandi-wa-bot, \
                            /bin/systemctl restart scandi-wa-bot, \
                            /bin/systemctl status scandi-wa-bot, \
                            /bin/systemctl start scandi-jarvis, \
                            /bin/systemctl stop scandi-jarvis, \
                            /bin/systemctl restart scandi-jarvis, \
                            /bin/systemctl status scandi-jarvis, \
                            /bin/systemctl start scandi-jarvis-cron.timer, \
                            /bin/systemctl stop scandi-jarvis-cron.timer, \
                            /bin/systemctl restart scandi-jarvis-cron.timer, \
                            /bin/systemctl status scandi-jarvis-cron.timer, \
                            /bin/systemctl start scandi-jarvis-workflow*, \
                            /bin/systemctl stop scandi-jarvis-workflow*, \
                            /bin/systemctl restart scandi-jarvis-workflow*, \
                            /bin/systemctl status scandi-jarvis-workflow*, \
                            /bin/systemctl enable scandi-jarvis-workflow*, \
                            /bin/systemctl disable scandi-jarvis-workflow*, \
                            /bin/systemctl reload caddy, \
                            /bin/systemctl restart caddy, \
                            /bin/systemctl status caddy, \
                            /bin/journalctl -u scandi-wa-bot *, \
                            /bin/journalctl -u scandi-jarvis *, \
                            /bin/journalctl -u scandi-jarvis-cron *, \
                            /bin/journalctl -u scandi-jarvis-workflow*, \
                            /bin/journalctl -u caddy *
```

Save and exit. Now every `jarvis ...` / `bot ...` command runs without a
sudo prompt.

---

## 4. Optional: summary-cron sidecar

The agent itself refreshes summaries lazily on each run, but for
chats that go quiet for a while (or get a sudden burst) you can run
the proactive worker on a systemd timer.

### 4.1 Service unit

`/etc/systemd/system/scandi-jarvis-cron.service`:

```ini
[Unit]
Description=scandi-jarvis — one-shot summary refresh pass
After=network-online.target scandi-jarvis.service
Wants=network-online.target

[Service]
Type=oneshot
User=scandi
Group=scandi
WorkingDirectory=/opt/scandi-jarvis
EnvironmentFile=/opt/scandi-jarvis/.env
ExecStart=/usr/bin/node dist/apps/whatsapp/summarize-cron.js

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/scandi-jarvis

StandardOutput=journal
StandardError=journal
SyslogIdentifier=scandi-jarvis-cron
```

### 4.2 Timer unit

`/etc/systemd/system/scandi-jarvis-cron.timer`:

```ini
[Unit]
Description=Run scandi-jarvis summary refresh every hour
After=scandi-jarvis.service

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scandi-jarvis-cron.timer
systemctl list-timers scandi-jarvis-cron.timer --no-pager
```

Check the last run's logs any time:

```bash
sudo journalctl -u scandi-jarvis-cron -n 50 --no-pager
```

---

## 4b. Workflows (deterministic scheduled tasks)

The `src/workflows/` system runs **deterministic, no-LLM** cron tasks
that report results back via the WhatsApp API — daily expense reports,
spreadsheet updates, etc. Distinct from the chat agent and from the
summary cron above; they share only the `WhatsappClient` and the env
loader.

See [`docs/WORKFLOWS.md`](./WORKFLOWS.md) for what each workflow does
and how to add a new one. Below is just the deployment plumbing.

### 4b.1 Single template service (one file, used by every workflow)

`/etc/systemd/system/scandi-jarvis-workflow@.service`:

```ini
[Unit]
Description=scandi-jarvis workflow %i
After=network-online.target scandi-jarvis.service
Wants=network-online.target

[Service]
Type=oneshot
User=scandi
Group=scandi
WorkingDirectory=/opt/scandi-jarvis
EnvironmentFile=/opt/scandi-jarvis/.env
# %i is the systemd template instance — i.e. the workflow name.
ExecStart=/usr/bin/node dist/apps/workflows-cron.js run %i

# Belt + braces: long-running smart reports can take ~60s; cap at 5 min.
TimeoutStartSec=5min

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/scandi-jarvis
ProtectKernelTunables=true
ProtectKernelLogs=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=scandi-jarvis-workflow-%i
```

That's the only service file you ever need. Every workflow is run as
`scandi-jarvis-workflow@<name>.service`.

### 4b.2 One timer per workflow

For each workflow you want to schedule, drop a `.timer` file. The
matching `.service` is auto-resolved from the template above.

**Example: `revolut-daily-expenses` at 00:01 Europe/Stockholm.**

`/etc/systemd/system/scandi-jarvis-workflow-revolut-daily-expenses.timer`:

```ini
[Unit]
Description=Daily Revolut expenses report (yesterday → WhatsApp)

[Timer]
Unit=scandi-jarvis-workflow@revolut-daily-expenses.service
OnCalendar=*-*-* 00:01:00
# Run in Europe/Stockholm wall-clock — matches the report's timezone.
# (systemd v245+; falls back to UTC silently on older systems.)
Persistent=true
AccuracySec=30s
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
```

Enable the workflow:

```bash
# Make sure the env vars exist first, otherwise the run fails immediately.
grep -E '^(REVOLUT_EXPENSES_API_BASE_URL|REVOLUT_EXPENSES_API_KEY|WORKFLOW_REVOLUT_CHAT_JID|JARVIS_WORKFLOWS_DEFAULT_CHAT_JID)=' \
     /opt/scandi-jarvis/.env

sudo systemctl daemon-reload
sudo systemctl enable --now scandi-jarvis-workflow-revolut-daily-expenses.timer

# Verify it's queued.
systemctl list-timers 'scandi-jarvis-workflow-*' --no-pager

# Run it once right now to validate end-to-end before midnight.
sudo systemctl start scandi-jarvis-workflow@revolut-daily-expenses.service
sudo journalctl -u scandi-jarvis-workflow@revolut-daily-expenses -n 50 --no-pager
```

### 4b.3 Specifying timezone (Stockholm wall-clock)

If your droplet's `/etc/timezone` isn't already `Europe/Stockholm`,
pin the calendar string explicitly:

```ini
[Timer]
OnCalendar=*-*-* 00:01:00 Europe/Stockholm
```

This is supported on systemd 245+ (Ubuntu 22.04+). Set it in every
`.timer` whose schedule you care about anchoring to local wall-clock.

### 4b.4 Adding a new workflow

1. Write the workflow under `src/workflows/<name>/index.ts` and register
   it in `src/workflows/index.ts` — see [`docs/WORKFLOWS.md`](./WORKFLOWS.md).
2. `jarvis deploy` to ship the build.
3. Drop a new `.timer` file in `/etc/systemd/system/` named
   `scandi-jarvis-workflow-<name>.timer` (the .service is reused).
4. Add it to the sudoers rule (§3.5) and `enable --now` it.

> The single `scandi-jarvis-workflow@.service` template never needs editing.

---

## 5. The `jarvis` helper (paste into `~/.bashrc`)

Mirrors the `bot` function in `scandi-wa-bot`'s `OPERATIONS.md`.

```bash
nano ~/.bashrc
```

Add at the bottom:

```bash
# ───── scandi-jarvis helpers ─────
jarvis() {
  case "$1" in
    logs)    sudo journalctl -u scandi-jarvis -f -o cat ;;
    raw)     sudo journalctl -u scandi-jarvis -f ;;
    tail)    sudo journalctl -u scandi-jarvis -n "${2:-100}" --no-pager -o cat ;;
    errors)  sudo journalctl -u scandi-jarvis -p warning -n "${2:-50}" --no-pager ;;
    since)   sudo journalctl -u scandi-jarvis --since "$2" -o cat ;;
    boot)    sudo journalctl -u scandi-jarvis -b -o cat ;;
    grep)    sudo journalctl -u scandi-jarvis -f -o cat | grep --color=auto -i "$2" ;;

    status)  sudo systemctl status scandi-jarvis --no-pager ;;
    start)   sudo systemctl start scandi-jarvis ;;
    stop)    sudo systemctl stop scandi-jarvis ;;
    restart) sudo systemctl restart scandi-jarvis ;;
    deploy)  /opt/scandi-jarvis/scripts/deploy.sh ;;

    health)  curl -fsS http://127.0.0.1:3000/health | jq . ;;

    cron)
      shift
      case "$1" in
        logs)    sudo journalctl -u scandi-jarvis-cron -f -o cat ;;
        tail)    sudo journalctl -u scandi-jarvis-cron -n "${2:-100}" --no-pager -o cat ;;
        status)  sudo systemctl status scandi-jarvis-cron.timer --no-pager ;;
        list)    systemctl list-timers scandi-jarvis-cron.timer --no-pager ;;
        run)     sudo systemctl start scandi-jarvis-cron.service ;;
        enable)  sudo systemctl enable --now scandi-jarvis-cron.timer ;;
        disable) sudo systemctl disable --now scandi-jarvis-cron.timer ;;
        *)       echo "usage: jarvis cron {logs|tail [N]|status|list|run|enable|disable}" ;;
      esac ;;

    workflow|wf)
      shift
      local wf="$1"; shift || true
      case "$wf" in
        list)
          # Walk the registry from the built JS — single source of truth.
          ( cd /opt/scandi-jarvis && /usr/bin/node dist/apps/workflows-cron.js list )
          echo
          echo "scheduled timers:"
          systemctl list-timers 'scandi-jarvis-workflow-*' --no-pager 2>/dev/null \
            | grep -E '(NEXT|scandi-jarvis-workflow)' || echo "  (none enabled)"
          ;;
        run)
          local name="$1"
          [ -z "$name" ] && { echo "usage: jarvis workflow run <name>"; return 2; }
          sudo systemctl start "scandi-jarvis-workflow@${name}.service"
          sudo journalctl -u "scandi-jarvis-workflow@${name}" -n 80 --no-pager
          ;;
        logs)
          local name="$1"
          [ -z "$name" ] && { echo "usage: jarvis workflow logs <name>"; return 2; }
          sudo journalctl -u "scandi-jarvis-workflow@${name}" -f -o cat
          ;;
        tail)
          local name="$1"; local n="${2:-100}"
          [ -z "$name" ] && { echo "usage: jarvis workflow tail <name> [N]"; return 2; }
          sudo journalctl -u "scandi-jarvis-workflow@${name}" -n "$n" --no-pager -o cat
          ;;
        status)
          local name="$1"
          [ -z "$name" ] && { echo "usage: jarvis workflow status <name>"; return 2; }
          sudo systemctl status "scandi-jarvis-workflow-${name}.timer" --no-pager
          echo
          sudo systemctl status "scandi-jarvis-workflow@${name}.service" --no-pager
          ;;
        enable)
          local name="$1"
          [ -z "$name" ] && { echo "usage: jarvis workflow enable <name>"; return 2; }
          sudo systemctl enable --now "scandi-jarvis-workflow-${name}.timer"
          ;;
        disable)
          local name="$1"
          [ -z "$name" ] && { echo "usage: jarvis workflow disable <name>"; return 2; }
          sudo systemctl disable --now "scandi-jarvis-workflow-${name}.timer"
          ;;
        next)
          systemctl list-timers 'scandi-jarvis-workflow-*' --no-pager
          ;;
        *)
          echo "usage: jarvis workflow {list|run|logs|tail|status|enable|disable|next} [name]" ;;
      esac ;;

    smoke)   cd /opt/scandi-jarvis && sudo -u scandi npx tsx scripts/wa-smoke.ts ;;

    *)
      cat <<EOF
usage: jarvis <command>

logs / raw           live tail (pretty / plain)
tail [N]             last N lines (default 100)
errors [N]           warnings + errors only
since "<time>"       e.g. jarvis since "10 min ago"
boot                 everything since last service start
grep "<pattern>"     live tail filtered (case-insensitive)

status               systemctl status
start | stop | restart
deploy               git pull → npm ci → build → restart

health               GET /health (loopback)
smoke                run scripts/wa-smoke.ts end-to-end

cron logs|tail|status|list|run|enable|disable
workflow list                                   # all registered + scheduled
workflow run     <name>                         # run one now (oneshot)
workflow logs    <name> | tail <name> [N]
workflow status  <name> | enable <name> | disable <name>
workflow next                                   # next-firing timers
EOF
      ;;
  esac
}
```

Reload your shell:

```bash
source ~/.bashrc
```

---

## 6. Register Jarvis as a webhook subscriber on the bot

Once Jarvis is running on `127.0.0.1:3000`, tell the WA bot to start
delivering webhooks to it. **This is a one-time step** — the
subscription persists in the bot's Postgres until you delete it.

```bash
# As scandi, from anywhere:
WA_BOT_TOKEN=$(grep ^API_AUTH_TOKEN= /opt/scandi-wa-bot/.env | cut -d= -f2-)
WA_WEBHOOK_SECRET=$(grep ^WA_WEBHOOK_SECRET= /opt/scandi-jarvis/.env | cut -d= -f2-)

curl -fsS -X POST http://127.0.0.1:8787/v1/webhooks \
  -H "Authorization: Bearer $WA_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- <<JSON | jq .
{
  "url": "http://127.0.0.1:3000/wa-webhook",
  "secret": "$WA_WEBHOOK_SECRET",
  "event_types": ["message.received", "message.processed"],
  "active": true,
  "description": "scandi-jarvis (DeepAgents WhatsApp frontend)"
}
JSON
```

(Use single-quotes around the heredoc body if your shell objects to
the literal `$WA_WEBHOOK_SECRET` — or just paste the value inline.)

You should get back the subscription object with an `id`. Save that id
somewhere — you'll use it to inspect deliveries:

```bash
curl -fsS -H "Authorization: Bearer $WA_BOT_TOKEN" \
  http://127.0.0.1:8787/v1/webhooks/<sub-id> | jq .
```

To change what events fire, `PATCH /v1/webhooks/<sub-id>` (see the
bot's `docs/API.md` §5). To temporarily mute deliveries (e.g. while
debugging) without losing the secret + URL:

```bash
curl -fsS -X PATCH http://127.0.0.1:8787/v1/webhooks/<sub-id> \
  -H "Authorization: Bearer $WA_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active":false}'
```

---

## 7. Deploying updates

Same flow as the bot:

```bash
jarvis deploy
```

Under the hood (`/opt/scandi-jarvis/scripts/deploy.sh`):

1. `git fetch origin main` — bail out if nothing changed.
2. `git pull --ff-only`.
3. `npm ci` — **only** if `package-lock.json` changed (saves 30-60s
   on code-only deploys).
4. `npm run build`.
5. `sudo systemctl restart scandi-jarvis`.
6. Quick `/health` ping, then tail the journal.

The systemd unit's `SIGTERM` handler drains in-flight runs (5s grace),
closes the Fastify socket, closes the Postgres pool, and lets the Deno
sandbox idle out — so a deploy mid-conversation won't drop the user's
message (the wa-bot retries deliveries with backoff if Jarvis is down
for the restart window).

> The cron unit (`scandi-jarvis-cron.service`) is `Type=oneshot` and
> doesn't need restarting — its next firing automatically uses the
> freshly-built `dist/`.

---

## 8. Healthchecks

### `GET /health` (loopback)

```bash
jarvis health
# {
#   "ok": true,
#   "wa_bot_connected": true,
#   "allowed_chats": -1,
#   "uptime_s": 312
# }
```

- `wa_bot_connected:true` means we can reach the bot's `/v1/health` and
  its WhatsApp socket is up.
- `allowed_chats:-1` means `*` (everything). A positive number is the
  count of JIDs in `JARVIS_WA_ALLOWED_CHATS`.

UptimeRobot / Healthchecks.io can't hit this through Caddy (we
deliberately don't expose Jarvis publicly), so if you want external
monitoring, add a Caddy route that proxies **only** `/health` from a
hostname you control:

```caddyfile
jarvis.example.com {
    @health path /health
    reverse_proxy @health 127.0.0.1:3000
    handle {
        respond "Not found" 404
    }
}
```

Most teams skip this — the bot's own `/v1/health` is already
externally monitored and Jarvis can't keep running if the bot dies, so
indirectly the bot's check covers both.

### End-to-end smoke

```bash
jarvis smoke
# POSTs a canned webhook envelope to /wa-webhook, asserts a reply is
# sent within N seconds. Useful right after `jarvis deploy`.
```

### Webhook delivery health (on the bot side)

```bash
psql "$(grep ^DATABASE_URL= /opt/scandi-wa-bot/.env | cut -d= -f2-)" -c "
SELECT status, count(*)
  FROM wa.webhook_deliveries
 WHERE inserted_at > NOW() - interval '1 hour'
   AND subscription_id = '<sub-id>'
 GROUP BY 1;
"
```

If you see a lot of `failed` / `abandoned` with `last_error` like
`ECONNREFUSED 127.0.0.1:3000`, Jarvis is down. `pending` rows that
aren't moving usually mean Jarvis is up but is taking longer than
`WEBHOOK_TIMEOUT_MS` to acknowledge — turn `LOG_LEVEL=debug` and look
at the dispatcher.

---

## 9. Logs

Everything goes through journald, same as the bot:

```bash
jarvis logs                   # live tail
jarvis tail 200               # last 200 lines
jarvis grep "send_message"    # live filter
jarvis since "5 min ago"      # window
jarvis errors                 # warn + error only
jarvis boot                   # since last restart
```

The journald retention you already configured for the bot
(`SystemMaxUse=500M`, `MaxRetentionSec=30day`) covers Jarvis too — no
extra config needed.

### What you'll actually see

Per request:

```
INFO  apps/whatsapp/webhook accepted {"id":"…","event":"message.received","chat_jid":"…"}
INFO  apps/whatsapp/dispatcher run started {"chat_jid":"…","triggering_seq":378}
INFO  apps/whatsapp/runner invoke {"chat_jid":"…","chat_type":"dm","triggering_seq":378,…}
INFO  core/tool-trace tool → whatsapp_react {"chat_jid":"…","input":"{\"emoji\":\"⏳\"}"}
INFO  core/tool-trace tool ← whatsapp_react {"chat_jid":"…","output":"{\"ok\":true,…}","ms":312}
INFO  core/tool-trace tool → SHOPIFY_GRAPH_QL_QUERY {"chat_jid":"…","input":"{\"query\":\"…\"}"}
INFO  core/tool-trace tool ← SHOPIFY_GRAPH_QL_QUERY {"chat_jid":"…","output":"…","ms":1421}
INFO  tools/whatsapp/send-message sent message {"chat_jid":"…","seq":380,"chars":712}
INFO  apps/whatsapp/runner run complete {"chat_jid":"…","ok":true,"aborted":false,"sent_message":true,…,"duration_ms":47794}
```

The `core/tool-trace` lines come from every tool call the agent
makes — including subagents (Shopify, etc.) and Composio tools that
don't log on their own. See `src/core/tool-trace.ts`.

---

## 10. Troubleshooting

| Symptom                                                                                            | Likely cause                                                                                                       | Fix                                                                                                                            |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Service flaps (start → exit → start)                                                               | Missing required env var, DB unreachable, or `WA_BOT_BASE_URL`/`WA_BOT_TOKEN` wrong.                              | `jarvis tail 50`. The preflight log line names the failed check.                                                               |
| `preflight: postgres failed` with `password authentication failed`                                 | URL-encoding of `@` in the password.                                                                               | Replace `@` with `%40` in `SUPABASE_DB_URL`.                                                                                   |
| `preflight: WA bot health failed` while the bot is clearly up                                      | `WA_BOT_TOKEN` doesn't match the bot's `API_AUTH_TOKEN` (trailing newline / whitespace).                          | Re-copy with `cat /opt/scandi-wa-bot/.env`; `chmod 600` on `/opt/scandi-jarvis/.env`.                                          |
| Bot delivers but Jarvis returns 401 / 403 on `/wa-webhook`                                         | `WA_WEBHOOK_SECRET` mismatch between Jarvis's `.env` and the subscription's `secret`.                              | Re-`PATCH /v1/webhooks/<id>` with the right `secret`, or roll a new one and update both.                                       |
| `400 querystring/after_seq must be >= 1`                                                           | Old build that paged messages with `after_seq=0` on first-summary runs. Fixed; redeploy.                            | `jarvis deploy`.                                                                                                               |
| `400 A maximum of 4 blocks with cache_control may be provided`                                     | DeepAgents' auto Anthropic prompt-caching middleware exceeding Anthropic's cap. Already disabled in the runner.   | `jarvis deploy` if you're on an old build; otherwise see `src/apps/whatsapp/runner.ts` (`enableCaching: false`).               |
| Agent runs, replies are sent, but the user sees nothing                                            | `JARVIS_WA_ALLOWED_CHATS` doesn't include the chat's JID. The dispatcher silently drops disallowed chats.          | Add the JID (use `*` for fully open) and `jarvis restart`.                                                                     |
| `whatsapp_send_file` returns `File '…' not found` instantly                                        | The WA file tools are using a different backend from `write_file` / `execute`.                                     | Already fixed in `src/apps/whatsapp/agent.ts` (passes the shared Deno sandbox). Redeploy.                                      |
| Agent reports the wrong local time                                                                 | Old build that defaulted to UTC and let the agent do TZ math.                                                      | `jarvis deploy`. Current tool defaults to `Europe/Stockholm` and returns `tz_abbrev`/`utc_offset` so there's no math to do.    |
| `MemoryMax=1500M` killed the service mid-run                                                       | Long conversation + big sandboxed tool output blew the cap.                                                        | Edit the unit, bump to `2G`, `daemon-reload`, restart. Long-term: tighten `JARVIS_WA_CONTEXT_MSGS` or `summarizationMiddleware`. |
| Webhook deliveries pile up `pending` on the bot side                                               | Jarvis is up but each run takes longer than `WEBHOOK_TIMEOUT_MS` (default 10s). The webhook ACKs *before* the run starts so this is rare. | Check `jarvis logs` for slow tools. The dispatcher ACKs the webhook immediately; deliveries should be sub-second.        |
| `LANGSMITH_TRACING=true` but nothing shows up                                                      | `LANGSMITH_API_KEY` missing or project name typo'd.                                                                | Check `LANGSMITH_PROJECT` in `.env` matches a project you can see in smith.langchain.com.                                      |
| Workflow `revolut-daily-expenses` fails: `RevolutExpensesHttpError: …` or `fetch failed` against `127.0.0.1:8080` | The `scandi-revolut-expenses` API isn't running on the droplet, or `REVOLUT_EXPENSES_API_KEY` doesn't match the API's `API_KEYS`. | `revolut status` / `revolut health` to confirm. Then re-check the key in `/opt/scandi-jarvis/.env` against `/opt/scandi-revolut-expenses/.env`. See [scandi-revolut-expenses/docs/DEPLOYMENT.md](../../scandi-revolut-expenses/docs/DEPLOYMENT.md). |

### Common forensic SQL

```sql
-- "Did this webhook id get dedupe'd?"
SELECT * FROM jarvis.wa_webhook_seen WHERE webhook_id = '<id>';

-- "What's the chat's current summary state?"
SELECT chat_jid, length(daily_summary), length(weekly_summary), length(longterm_summary),
       daily_through_seq, weekly_through_seq, longterm_through_seq, length(notes),
       updated_at
  FROM jarvis.chat_context
 WHERE chat_jid = '<chat-jid>';

-- "Show me the last few LangGraph checkpoints for this chat."
SELECT thread_id, checkpoint_id, parent_checkpoint_id
  FROM langgraph.checkpoints
 WHERE thread_id = '<chat-jid>'
 ORDER BY checkpoint_id DESC
 LIMIT 5;
```

---

## 11. Backups

Same as the bot — the droplet holds no irreplaceable state. What matters
lives in Supabase:

| Data                                | Where                                                       | Backed up by                       |
| ----------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| Chat summaries + notes              | `jarvis.chat_context`                                       | Supabase daily snapshot            |
| Webhook idempotency                 | `jarvis.wa_webhook_seen` (24h TTL — disposable)             | (no backup needed)                 |
| LangGraph checkpoints (per chat)    | `langgraph.checkpoints`                                     | Supabase daily snapshot            |
| `.env` + sandbox token              | `/opt/scandi-jarvis/.env`                                   | **You** — password manager copy.   |

If a chat's checkpoint table grows unwieldy, you can wipe per-thread
state without losing summaries/notes:

```sql
DELETE FROM langgraph.checkpoints      WHERE thread_id = '<chat-jid>';
DELETE FROM langgraph.checkpoint_writes WHERE thread_id = '<chat-jid>';
```

Next run for that chat rebuilds context from `jarvis.chat_context` +
the bot's REST API + a fresh checkpoint thread.

---

## 12. (Optional) GitHub Actions deploy

The wa-bot's GitHub Actions workflow already targets this droplet. To
also deploy Jarvis on pushes to `main`, add a second workflow under
`.github/workflows/deploy.yml` in **this** repo:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host:     ${{ secrets.DROPLET_HOST }}
          username: scandi
          key:      ${{ secrets.DROPLET_SSH_KEY }}
          script:   /opt/scandi-jarvis/scripts/deploy.sh
```

Reuse the same `DROPLET_HOST` and `DROPLET_SSH_KEY` secrets as the bot
repo.

---

## TL;DR — copy/paste path

```bash
# ── 1. install (as scandi) ─────────────────────────────────────────────
sudo mkdir -p /opt/scandi-jarvis && sudo chown scandi:scandi /opt/scandi-jarvis
cd /opt && git clone https://github.com/<you>/scandi-jarvis.git
cd scandi-jarvis && npm ci && npm run build

# ── 2. config ──────────────────────────────────────────────────────────
cp .env.example .env && nano .env
#  Required:
#    ANTHROPIC_API_KEY=…
#    WA_BOT_BASE_URL=http://127.0.0.1:8787
#    WA_BOT_TOKEN=$(grep ^API_AUTH_TOKEN= /opt/scandi-wa-bot/.env | cut -d= -f2-)
#    WA_WEBHOOK_SECRET=$(openssl rand -hex 32)
#    SUPABASE_DB_URL=$(grep ^DATABASE_URL= /opt/scandi-wa-bot/.env | cut -d= -f2-)
#    JARVIS_WA_ALLOWED_CHATS=*   # or a comma-separated whitelist
#  Recommended:
#    DENO_DEPLOY_TOKEN=…   COMPOSIO_API_KEY=…   TAVILY_API_KEY=…
#    LANGSMITH_TRACING=true LANGSMITH_API_KEY=… LANGSMITH_PROJECT=scandi-jarvis
chmod 600 .env

# ── 3. migrate ─────────────────────────────────────────────────────────
psql "$(grep ^SUPABASE_DB_URL= .env | cut -d= -f2-)" -f db/migrations/001_jarvis_init.sql

# ── 4. systemd ─────────────────────────────────────────────────────────
sudo nano /etc/systemd/system/scandi-jarvis.service       # paste §3.4
sudo nano /etc/systemd/system/scandi-jarvis-cron.service  # paste §4.1 (optional)
sudo nano /etc/systemd/system/scandi-jarvis-cron.timer    # paste §4.2 (optional)
sudo systemctl daemon-reload
sudo systemctl enable --now scandi-jarvis
sudo systemctl enable --now scandi-jarvis-cron.timer      # optional

# ── 5. sudoers entry (extend §3.5) + helper function in ~/.bashrc ──────
sudo visudo -f /etc/sudoers.d/scandi-deploy               # see §3.5
nano ~/.bashrc                                            # paste `jarvis()` from §5
source ~/.bashrc

# ── 6. register webhook with the bot ───────────────────────────────────
WA_BOT_TOKEN=$(grep ^API_AUTH_TOKEN= /opt/scandi-wa-bot/.env | cut -d= -f2-)
WA_WEBHOOK_SECRET=$(grep ^WA_WEBHOOK_SECRET= /opt/scandi-jarvis/.env | cut -d= -f2-)
curl -fsS -X POST http://127.0.0.1:8787/v1/webhooks \
  -H "Authorization: Bearer $WA_BOT_TOKEN" -H "Content-Type: application/json" \
  -d "{\"url\":\"http://127.0.0.1:3000/wa-webhook\",\"secret\":\"$WA_WEBHOOK_SECRET\",
       \"event_types\":[\"message.received\",\"message.processed\"],\"active\":true,
       \"description\":\"scandi-jarvis\"}" | jq .

# ── 7. smoke test ──────────────────────────────────────────────────────
jarvis health
jarvis smoke
jarvis logs
```

After this, the agent is steady-state — restart-on-fail, journald-logged,
upgrade with `jarvis deploy`. Build new agents under `src/agents/` and
they'll be reachable through the same WhatsApp frontend on next deploy.
