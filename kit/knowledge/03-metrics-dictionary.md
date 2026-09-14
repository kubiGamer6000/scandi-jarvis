# Metrics Dictionary

The single most common way to be wrong about Scandi's numbers is to compute a metric
that already has a house definition, using a different one. This file is the
canonical list. Where two definitions exist, the canonical one is marked.

## Revenue

| Term | Definition |
|---|---|
| **Total Revenue** ✅ canonical | ShopifyQL `total_sales` = gross sales − discounts − returns + shipping + tax. Refunds land on the **refund date**, not the original order date. Stored in `shopify_daily.total_revenue`. |
| Gross sales | Before discounts and returns. Rarely the right number. |
| Net sales | Shopify's `net_sales` — gross − discounts − returns, **excluding** shipping and tax. |
| Recurring revenue | Revenue from orders tagged `Subscription Recurring Order` (or `Subscription Order: 2` / `: 3`). Net of refunds booked that day. |
| New sub revenue | Revenue from orders tagged `Subscription First Order`. |
| Non-recurring revenue | `total_revenue − recurring_revenue`. Used for "profit without subs". |
| New-customer revenue | Shopify's first-time-buyer split. Used for NC-ROAS. |

Because there is **no VAT**, gross and net are the same at the company level — the
tax component inside `total_sales` is nominal.

## Order counts

- **Total orders** — ShopifyQL `orders`.
- **Reshipped orders** — €0 orders excluding refunded ones. The old sheet capped this
  at 5/day; the app writes the real count (often 8–9+).
- **First-ever order** — customer's lifetime order count equals their in-window count
  *and* their earliest order is in the window. This is stricter than "new customer"
  and is what the cashflow model uses.

## AOV

> ⚠️ **Use Shopify's reported `average_order_value`, not `revenue / orders`.**
> The two differ by 1–6% because of how Shopify handles refunds and multi-currency.
> The reported figure is only valid for a **single day** — it cannot be summed or
> averaged across a range. For a range, you must recompute from components.

Anchors: first-order AOV ≈ **€46.04** (used in the cashflow model to convert
new-customer revenue into subscriber counts).

## Ad spend

| Term | Definition |
|---|---|
| **Blended ad spend** ✅ canonical | Sum of `ads_daily` across Facebook + Google + TikTok, after source precedence is resolved. |
| Meta spend | Per-account from the Marketing API, converted to EUR at the rate on that date. |
| Visible ads | Ad charges observable on the Revolut statement. |
| Total ads | Visible ads **+ Juni transfers**. Use this one for anything spanning Aug 2026. |

> ⚠️ **Never add raw Meta API spend to Triple Whale spend.** That double-counts
> Facebook. The `ads_daily` table exists precisely to resolve this.

## Efficiency ratios

All ratios are computed as `SUM(numerator) / SUM(denominator)` over the requested
range — **never** as an average of per-day ratios. The daily tables deliberately
store only additive components for this reason.

| Metric | Formula |
|---|---|
| Blended ROAS | `total_revenue / total_ad_spend` |
| **NC-ROAS** | `new_customer_revenue / total_ad_spend` — the one that actually governs scaling decisions |
| MER | `net_revenue / total_ad_spend` |
| CAC per subscriber | `total_ad_spend / new_subs` |
| CPA / CPM / CVR | standard, from Meta components |

## Cost rates

| Rate | Value | Where |
|---|---|---|
| Payment gateway fee | **4%** of revenue (`payment_gateway_pct = 0.04`) | dashboard |
| Payment gateway fee | 3.5% (`gatewayPct`) | breakeven model — older assumption |
| COGS estimate fallback | **40%** of revenue (`cogs_estimate_pct = 0.4`) | dashboard |
| Measured blended COGS | 39.59% of revenue | cashflow model, 31-day measurement |
| Subscription net margin | **57%** (`subscription_margin_pct = 0.57`) | used only for projected subscription profit |

Rates are **effective-dated** in the `settings` table, so changing one never rewrites
history. A range that spans a rate change is split at the boundary.

## Subscription metrics

See `05-subscriptions-and-mrr.md` for the full treatment. **There is no single "MRR" —
four framings spanned €442k–€605k on the same day. Lead with the 30-day ceiling (the
house number), always pair it with calendar MRR, and offer to explain the gap.**
Short version:

| Term | Definition |
|---|---|
| **30-day ceiling** ← the house number | Every scheduled Skio charge landing in the next 30 store-local days, assuming full collection. The dashboard headline and the sheet's `Total MRR (Skio)`. Lead with it — but its day-over-day change is *not* growth. |
| **Calendar MRR** ← always report alongside | `charge × (30.436875 / intervalDays)`. Same book normalised to a real calendar month, ~8% above the ceiling. The **growth / run-rate** framing. |
| Four-week MRR | Skio's own dashboard framing (one cycle = one "month"). Reconciliation only; understates a calendar month by ~8.5%. |
| Realistic revenue | The ceiling, risk-adjusted by chained per-cycle collection probabilities. The honest forecast of what will collect. |
| Queued revenue | Sum of every sub's next charge, whenever it falls. |
| Active subs | Skio status ACTIVE. |
| Subs in dunning | `statusContext = 'DUNNING'` — payment failing. |
| `cyclesCompleted` | **Includes the checkout order as cycle 1.** Never-rebilled means `cyclesCompleted <= 1`. |

## Unit economics

| Term | Definition |
|---|---|
| Contribution margin (CM) | `revenue − COGS − gateway fees − refunds` |
| Margin % | `CM / revenue` |
| **Breakeven ROAS** | `1 / contribution`, where contribution sums day-0 margin plus discounted future rebill margins |
| Lifetime multiple | `1 + Σ(survival × rebillUplift)` across cycles |
| Refund rate | Measured on **mature orders only** (>45 days old), split first-order vs rebill |

## Retention

Per-cycle survival rates from the cashflow model:

```
cycle 1→2: 73.7%    2→3: 44.4%    3→4: 50.6%
cycle 4→5: 62.5%    5→6: 77.6%    tail: ~65%
```

The **cycle 2→3 cliff** (~45%) is the defining feature of this business's retention
curve. Any LTV model that assumes a smooth decay will be badly wrong.

The risk model's collection probabilities are slightly different (73.5% for 1→2,
45.7% for 2→3) because they measure *collection*, not *survival* — they include
payment failure, not just cancellation.
