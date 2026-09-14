# Other APIs — 17track, FX, Google Sheets, Chatwoot

> Reference facts about systems used elsewhere in the business. Jarvis has **no
> client or credentials** for 17track, Google Sheets, Chatwoot, Anthropic or
> Firebase — don't try to call them. FX conversion is available through
> `/home/app/kit/lib/fx.ts`.

## 17track — parcel tracking

| | |
|---|---|
| Base | `https://api.17track.net/track/v2.4` (older code uses `v2.2`) |
| Auth | `17token: ${SEVENTEENTRACK_API_KEY}` |

Endpoints:

| Endpoint | Cost |
|---|---|
| `POST /register` | **1 quota per number, permanent** |
| `POST /gettrackinfo` | free for already-registered numbers |
| `POST /getquota` | free |

```typescript
const client = axios.create({
  baseURL: 'https://api.17track.net/track/v2.4',
  headers: { '17token': env.seventeentrackApiKey, 'Content-Type': 'application/json' },
});
await client.post('/gettrackinfo', numbers.map(n => ({ number: n })));
```

### Rules

1. **Check Shopify `deliveredAt` first.** It's free. Only fall back to 17track for
   parcels Shopify doesn't know about.
2. **Registration is permanent**, so re-probing an already-registered number costs
   nothing. `estimateQuota.ts` probes `gettrackinfo` first to compute exactly how
   much quota a run will actually need.
3. Error code **`-18019908`** = quota exhausted. Registration silently stops. Top up
   at api.17track.net.
4. **PostNL requires `destination_postal_code`** on register. `retryPostnl.ts` tries
   the zip both with and without spaces.
5. After registering, sleep ~3s before calling `gettrackinfo`.
6. **"No info" almost always means never registered**, not a lost parcel.

Retry on 500/503/429, exponential, max 3.

## FX / currency

No auth on any of these.

| Service | URL | Use |
|---|---|---|
| Frankfurter (ECB) | `https://api.frankfurter.dev/v1/latest?base=EUR` | primary |
| Frankfurter historical | `https://api.frankfurter.dev/v1/{date}?from=EUR` | by-date conversion |
| Frankfurter (old host) | `https://api.frankfurter.app/latest?from=USD&to=EUR` | older scripts |
| open.er-api.com | `https://open.er-api.com/v6/latest/EUR` | fallback for non-ECB currencies (AED, SAR, QAR, KWD…) |

Convention: rates are **units of currency per 1 EUR**, so `amountEur = amount / rate`.

Rates are persisted to the `fx_rates` table (`PK (date, currency)`) so historical
conversions are reproducible. There is also a hardcoded fallback table (~18
currencies) and a cached USD→EUR of `0.86682` used by the breakeven sheet.

> ⚠️ Read the FX outage story in `05-subscriptions-and-mrr.md`. Both providers
> went down on 25 Aug and ~1,100 subs were silently valued at zero. Any code
> converting a large base must assert coverage before publishing.

## Google Sheets — the profit sheet

| | |
|---|---|
| Auth | Service account JWT, `GOOGLE_SERVICE_ACCOUNT_KEY` (base64 of the JSON) |
| Sheet | `GOOGLE_SHEET_ID` = `12A_b5iK6h730nIsL1tRozAnFWpbgHVJWrrfrjwnPJy4` |
| Name | `ScandiGum Progress Sheet`, tab `Sheet1` |
| Library | `googleapis` sheets v4 |

Read via `spreadsheets.values.get`. Writes go through a three-way merge with shadow
and conflict tables (`sheet_sync_shadow`, `sheet_sync_conflicts`).

> **Sheet sync halts on column layout mismatch, by design.** If someone inserts a
> column, the sync stops rather than writing to the wrong place. Check
> `GET /api/sheet/audit`.

~60 columns, each classified push / formula / both / ignore — documented in
`d:\scandi\ultimate-scandi-app\docs\SHEET-FIELDS.md`.

## Chatwoot — customer support

| | |
|---|---|
| Base | `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}` |
| Auth | `api_access_token: ${CHATWOOT_API_TOKEN}` |
| Account | `155355`, inbox `99613` |

Used by the `shopify-chatwoot-sync` app, which does contact sync from Shopify,
Claude-powered draft replies, an autonomous AgentBot, and a Customer 360 dashboard
embedded in Chatwoot. Not integrated into the profit dashboard (planned in VISION.md,
never built).

## Revolut / Juni — no API

Bank data enters via **CSV export** only:

- `account-statement_*.csv` → cashflow and credit analysis
- `transaction-statement_*.csv` → intercompany/Kybalion analysis

There is no Revolut API — the CSVs are the only source of bank data. Parse them
with `csv-parse` rather than an LLM: the layout is stable and deterministic
parsing is cheaper and reproducible.

## Anthropic

`ANTHROPIC_API_KEY` powers the support bot. Models in use: `claude-sonnet-4-6` for
drafts/responses, `claude-haiku-4-5` for the cheap per-message classifier.

## Firebase / Firestore

Project `kybalion-pb`. Stores AI customer summaries, admin config, and prompt/model
overrides that layer on top of env defaults. Not part of the analytics stack.
