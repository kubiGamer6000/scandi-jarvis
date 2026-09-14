# Profit API endpoints

Twenty read endpoints. This list can drift; the authoritative one ships with the
deployment and is worth fetching when something here doesn't match:

```bash
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts raw /api/openapi.json
```

All data routes accept `?from=YYYY-MM-DD&to=YYYY-MM-DD` or `?days=N`, plus
`&store=scandi-eu`. `days` counts back from `to` and applies **only when `from`
is omitted**. Boundaries are Europe/Stockholm.

## The four that answer most questions

| Path | Returns |
|---|---|
| `/api/summary` | Revenue, orders, new vs returning customers, traffic, ads by platform, subscription totals, the full `profit` breakdown, `dataQuality.daysMissingCogs` |
| `/api/subscriptions` | **The MRR endpoint** — all four framings, history, the movement bridge, risk model, failed payments |
| `/api/daily` | Per-day `profitEur`, `marginPct`, `profitIsEstimated` — the series behind every chart |
| `/api/sync/status` | Freshness per source and whether the worker is alive. **Check this before trusting an odd-looking number** |

## The rest

| Path | Returns |
|---|---|
| `/api/forecast` | Forecast scored against actuals, with MAPE — use it to judge how much to trust the projection |
| `/api/hourly?date=` | One day in 24 buckets, with `isPartial` |
| `/api/hourly/profile` | Hour-of-day averages across a range |
| `/api/ads` | `blended`, per-platform, per-account, plus `triplewhaleUnresolved`. `&all=true` includes accounts excluded from blended |
| `/api/ads/accounts` | Every account, whether it counts toward blended, and what is pending review |
| `/api/dunning` | Headline plus by-day collection and recovery rates |
| `/api/dunning/failures` | Subscription-level failed payments, newest first |
| `/api/cancellations` | Totals and daily split by how the cancel happened (API / cancel flow / merchant) |
| `/api/cancellations/sessions` | Individual cancel-flow sessions **including saves**, so the offer that retained someone is visible |
| `/api/manual` | Hand-entered COGS and other fields — what turns estimated profit into actual profit |
| `/api/settings` | Gateway %, COGS estimate %, subscription margin. **Effective-dated**, so a change doesn't rewrite past profit |
| `/api/stores` | Store config |
| `/api/sync/revisions` | Audit log of every revised figure, old and new. Mostly Meta drift |
| `/api/sheet/audit` | Sheet layout check |
| `/api/sheet/conflicts` | Where the sheet and the database disagree and the sync declined to guess |
| `/api/auth/session` | Confirm the credential works |
| `/api/openapi.json` | This list, authoritatively |

## Reading the profit response

```
profit.profit.trueProfitEur         revenue - adSpend - cogs - gatewayFees
profit.profit.marginPct
profit.profit.isEstimated           true if ANY COGS in the window was a 40% guess
profit.profit.estimatedComponents   which parts, e.g. ["cogs"]
profit.cogs.source                  actual | estimated | mixed | none
profit.cogs.estimatedShareOfRevenue "26% of this window is assumed, not measured"
profit.cogs.daysActual / daysEstimated
profit.profitExcludingSubsEur       often NEGATIVE while total profit is positive
dataQuality.daysMissingCogs         the exact dates to go fill in
```

## Sync cadence (Europe/Stockholm)

Worth knowing when judging whether a number is stale.

| Source | Frequency |
|---|---|
| Shopify daily / Triple Whale daily | every 5 min (today + yesterday) |
| Meta | every 15 min (trailing 3 days) + 03:20 seven-day sweep |
| Skio incremental | every 10 min |
| Skio full | 02:00 nightly |
| Skio priced | 02:30 / 08:30 / 14:30 / 20:30, plus 23:30 end-of-day |
| Skio MRR observed | hourly at :50 |
| Skio dunning | every 20 min |
| Ads resolve / sheet sync | every 5 min |
| FX | 04:15 |

## The underlying database

Postgres 17, Drizzle ORM. Direct SQL is possible for anything the API doesn't
expose, but prefer the API — it encodes the precedence rules. One design rule
matters when writing SQL:

> **Daily tables store additive components only.** CVR, AOV, ROAS, CPA and CPM
> are always `SUM(numerator) / SUM(denominator)` over the requested range —
> never stored pre-averaged, and never averaged across days.

Main tables: `shopify_daily`, `triplewhale_daily`, `meta_daily`, `ads_daily`,
`skio_daily`, `manual_daily`, `shopify_hourly`, `triplewhale_hourly`,
`skio_subscriptions`, `skio_subscription_lines`, `skio_revenue_snapshots`,
`skio_mrr_hourly`, `skio_mrr_movements`, `skio_risk_snapshots`,
`skio_cycle_transitions`, `skio_billing_attempts`, `skio_cancellations`,
`fx_rates`, `settings`, `fact_revisions`, `sync_state`, `api_keys`.

Money is `numeric(14,4)`, rates are `numeric(12,8)`, and primary keys almost
always include `store_id`.
