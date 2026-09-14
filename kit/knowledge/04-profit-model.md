# The Profit Model

This is the most important file in the knowledge base. Profit is the number the
business runs on, and there are two versions of it in circulation.

## The canonical formula

Implemented in `d:\scandi\ultimate-scandi-app\src\repos\profit.ts`. Profit is
**derived on read**, never stored — it is resolved per day, then summed.

```
For each day d:
    gatewayFees_d = revenue_d × gatewayPct_d
    cogs_d        = manualCogs_d  ?? (revenue_d × cogsEstimatePct_d)
    profit_d      = revenue_d − adSpend_d − cogs_d − gatewayFees_d
    margin_d      = profit_d / revenue_d

Range total = Σ profit_d
```

Verbatim, from `byDay`:

```typescript
const gatewayPct = gatewayRates.get(day.date) ?? 0;
const estimatePct = cogsRates.get(day.date) ?? 0;
const adSpendEur = spendByDay.get(day.date) ?? 0;
const gatewayFeesEur = day.revenue * gatewayPct;
const isEstimated = day.cogsEntered == null;
const cogsEur = isEstimated ? day.revenue * estimatePct : day.cogsEntered!;
const profitEur = day.revenue - adSpendEur - cogsEur - gatewayFeesEur;
```

### Why per-day and not on range totals

Two reasons, both deliberate:

1. Rates are effective-dated, so a rate change can split a range mid-window.
2. A range with some days entered and some estimated reports `mixed` rather than
   picking one label and being wrong about half the days.

## The four inputs

### 1. Revenue

`shopify_daily.total_revenue`, which is ShopifyQL `total_sales`:
**gross − discounts − returns + shipping + tax.**

Refunds are already netted, on the refund date. **Do not subtract refunds again.**
Because there is no VAT, the tax component is nominal.

### 2. Ad spend

From `ads_daily`, summed across all platforms, after source precedence is resolved
(sheet vs Meta API vs Triple Whale). Not raw Meta + Triple Whale added together —
that double-counts Facebook.

### 3. COGS

Two modes:

- **Actual** — `manual_daily.cogs_eur`, entered by a human nightly. This is the
  **landed** cost: product + inbound shipping + duties.
- **Estimated** — when no entry exists, `revenue × 40%`.

The estimate is the entire reason the app's profit is more correct than the sheet's.
The sheet treats a blank COGS cell as **zero**, which is why 28 Jul 2026 reads a
50.77% margin in the sheet. From the source comment:

> The sheet's `True Profit = (B-V-AB)-(B*0.04)` treats a blank COGS cell as zero...
> Substituting the estimate fixes the number. Keeping a flag on the result is what
> stops that fix from becoming a new lie. An estimated profit is labelled as one,
> all the way to the UI.

**Any profit figure must carry its `isEstimated` flag and `daysMissingCogs`.**
Reporting an estimated profit as if it were measured is the failure mode this whole
design exists to prevent.

There is **no per-SKU COGS** anywhere. COGS is a daily blended number.

### 4. Gateway fees

`revenue × payment_gateway_pct`, default **4%**. Flat assumption, matches the
sheet's `(B × 0.04)`.

## What is NOT in True Profit

Be explicit about this when reporting — it is **contribution margin, not net profit**:

- Salaries and contractor costs
- Overhead, rent, office
- SaaS / app subscriptions (Klaviyo, Triple Whale, Loox, Skio, Gorgias, Anthropic…)
- Wayflyer financing cost
- VAT (none owed)
- Shipping-to-customer as a separate line — it is inside manual COGS when entered

Monthly overhead can be derived from the Revolut statement via
`local-scripts/cashflow/overheadFromBank.ts` if a true net figure is needed.

## Sheet vs App

| | Sheet | App |
|---|---|---|
| Formula | `(B − V − AB) − (B × 0.04)` | same shape |
| Blank COGS | treated as **0** → inflated margin | 40% estimate + flag |
| Ad spend | single Meta account historically | multi-account blended |
| Handover date | sheet wins on/before **2026-07-28** | app wins after |

`stores.sheet_handover_date = 2026-07-28`. For dates on or before that, the sheet is
authoritative for ads (closed Meta accounts, unreliable early Triple Whale data).
After it, the app is.

## Profit excluding subscriptions

```typescript
cogsNonRecurring += day.nonRecurringRevenue * estimatePct;
profitExcludingSubsEur = nonRecurringRevenue - cogsNonRecurring - adSpendEur;
```

Note this **always** uses the 40% estimate against non-recurring revenue, even when
actual COGS exists, and it omits gateway fees. It mirrors the sheet's "Profit w/o
Subs" column. It is a different question, not a better answer — don't mix it with
True Profit.

## Projected subscription profit

Separate concept, on `/api/subscriptions`:

```typescript
projectedProfit.onRealisticEur = revenue.realisticTotal * subscription_margin_pct; // 0.57
projectedProfit.onCeilingEur   = revenue.ceilingTotal   * subscription_margin_pct;
```

This is a **forward projection on subscription revenue**, at a 57% net margin. It is
not part of True Profit and must never be added to it.

## Quick reference

```
True Profit  = Σ_days [ revenue − adSpend − COGS − (revenue × 4%) ]
COGS         = manual entry, else revenue × 40% (flagged)
Margin %     = profit / revenue
Excludes     = salaries, overhead, SaaS, financing
```
