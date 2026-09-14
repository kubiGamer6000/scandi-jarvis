---
name: scandi-profit-api
description: Reads Scandi Gum's live profit, revenue, margin, COGS, MRR, subscription, blended ad spend, dunning, cancellation and forecast numbers from the internal dashboard API. Use whenever the user asks how the business is doing, what profit or margin was, what MRR is, how subscriptions or churn are trending, how much was spent on ads, or asks for any daily/weekly/monthly business figure — this is the first place to look, before Shopify, Meta or Skio.
---

# Scandi Profit API

Our own dashboard API. It already resolves ad-spend precedence, effective-dated
rates, COGS fallback, the Skio charge model and the risk haircut. Recomputing
those from raw APIs is how the rules get silently dropped.

```bash
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts summary --days 7
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts mrr
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts daily --days 30
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts ads --from 2026-08-01 --to 2026-08-31
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts health
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts raw /api/cancellations --days 30
```

Every command takes `--days N` or `--from YYYY-MM-DD --to YYYY-MM-DD`, and
`--json` for the unformatted response. Day boundaries are **Europe/Stockholm**.

## When this is the wrong tool

The API is **aggregated and daily**. The moment a question needs one record,
go to the source:

| Need | Go to |
|---|---|
| A single order, or line items | Shopify (`scandi-shopify`) |
| One ad, or creative performance | Meta at `level=ad` (`scandi-meta-ads`) |
| One subscriber's history | Skio (`scandi-skio`) |
| Anything before the app started syncing | the source APIs |

## Reporting profit

`profit` prints the margin **and** how much of it is measured. Never quote one
without the other:

> A 30.7% margin where 26% of revenue carries a flat 40% COGS guess is a
> different claim from a measured one.

Read `profit.cogs.source` (`actual` / `estimated` / `mixed` / `none`),
`profit.cogs.estimatedShareOfRevenue`, and `dataQuality.daysMissingCogs` —
that last one is the exact list of dates someone needs to fill in.

Also watch `profitExcludingSubsEur`. It is routinely **negative** while total
profit is positive, which means new-customer acquisition is running at a loss
and subscriptions are carrying the business. That is usually the real answer to
"how are we doing?", so surface it rather than burying it.

## Reporting MRR

**Lead with the 30-day ceiling, always report calendar MRR next to it, and
offer to explain the difference.** Four framings spanned €442k–€605k on the
same day, so a bare "MRR is X" is never complete.

| Framing | Field | Role |
|---|---|---|
| **30-day ceiling** | `revenue.ceilingTotal` | **The house number.** Dashboard headline, and the sheet's `Total MRR (Skio)`. |
| **Calendar MRR** | `revenue.mrrCalendar` | **Always pair it with the ceiling.** The growth / run-rate figure. |
| Realistic | `revenue.realisticTotal` | When the question is about cash we'll actually collect. |
| Four-week | `revenue.mrrFourWeek` | Only to reconcile against Skio's own dashboard. |

**The ceiling's day-over-day change is not growth.** A rolling 30-day window
over 28-day billing cycles captures a different number of charges each day, so
it moves with zero net adds and zero churn. That artefact lands in
`movements[].residual`, which was **−€9,130** of a −€15,238 move on one live
day — the majority. The `mrr` command decomposes this for you and warns when
the residual dominates. For "did we grow?", lead with calendar instead.

`haircutPct` is **derived**, not fixed. It has sat near 21.3% twice; read it
rather than hardcoding it.

## Freshness

MRR is a **nightly derive**, not live — `revenue.snapshotAt` says when it was
computed, usually around 00:45. An intraday MRR question is being answered with
last night's snapshot, so say so.

Run `health` before trusting a number that looks odd. The API serves stale data
quite happily if the sync worker is down.

## Endpoints

`profit.ts raw <path>` hits anything. The full list with parameters is in
[references/endpoints.md](references/endpoints.md), and the authoritative
version ships with the deployment:

```bash
tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts raw /api/openapi.json
```

## Auth

Handled by the credential gateway — the key never enters the sandbox. It is
read-only and enforced structurally — a key may
only issue GETs, and every mutation is a POST/PUT/PATCH. There is no path by
which it can trigger a sync, change rates or overwrite COGS. There is also **no
rate limiting**, only a 30s request timeout, so be considerate rather than
relying on a throttle to catch a loop.

If a call fails with a gateway error, report the error text to the user rather
than working around it.
