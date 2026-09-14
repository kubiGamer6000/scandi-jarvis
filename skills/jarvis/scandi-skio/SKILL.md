---
name: scandi-skio
description: Queries Scandi Gum's Skio subscription platform for individual subscriber records, billing schedules, cancellations, cancel-flow sessions, dunning and payment attempts. Use when the user asks about a specific subscriber or subscription, why someone cancelled, what the cancel flow offered, billing attempt history, or needs subscription records rather than totals. For MRR, churn rates and subscription totals use scandi-profit-api instead.
---

# Skio (subscriptions)

Hasura GraphQL at `https://graphql.skio.com/v1/graphql`. Auth is handled by the
credential gateway (no key in the sandbox); access is read-only — queries go
through, mutations are refused. If a call fails with a gateway error, report the
error text to the user.

**Check `scandi-profit-api` first.** MRR in every framing, churn, dunning
rates, cancellation splits and the movement bridge are already computed there
with the charge model applied. Come to Skio for **individual records** —
one subscriber, one cancel-flow session, one billing attempt.

```bash
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts introspect             # list tables
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts introspect Subscriptions  # list its fields
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts sub <subscription-id>
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts email someone@example.com
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts cancels --days 14
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts gql '{ Subscriptions(limit: 1) { id } }'
```

## The indexing trap — read this before writing a query

> Very few columns are indexed. Filtering `BillingAttempts` on
> `subscriptionBillingDate` takes **over seven minutes and then times out**,
> while the same filter on `createdAt` or `updatedAt` returns in **five
> seconds**.

**Filter on `createdAt` or `updatedAt`. Never on a business-date column.** Pull
on a watermark and do the date analysis locally. This is the single most
important operational fact about this API.

## Introspect before guessing field names

Introspection is enabled. The original field set in our code was assembled by
guessing names and reading errors, which is exactly why `BillingAttempts`,
`AuditLog` and the cancel-flow tables went unnoticed for months.

```bash
tsx /home/app/skills/jarvis/scandi-skio/scripts/skio.ts introspect Subscriptions
```

## Field semantics — the ones people get wrong

| Field | Meaning |
|---|---|
| `cyclesCompleted` | **Includes the checkout as cycle 1.** Never rebilled = `<= 1`. The next rebill carries Shopify tag `Subscription Order: cyclesCompleted + 1`. |
| `status = CANCELLED` with no `statusContext` | Genuine voluntary cancel |
| `statusContext = 'DUNNING'` | Involuntary — payment is failing |
| `statusContext = 'TEMPORARILY_PAUSED'` | Paused, and excluded from the MRR ceiling |
| `BillingPolicy` | `interval: WEEK, intervalCount: 4` = **28 days**, ~89.6% of the base |
| `priceWithoutDiscount` | Recurs at full price |
| `deliveryPrice` / `deliveryPriceOverride` | Override wins. Recurs. |
| Discount `type` | Only `CANCEL_DISCOUNT` recurs |

Checkout discount codes (`FLEXIBLE30` and similar) **do not apply on rebills**;
retention discounts do. Getting this backwards misprices the whole book.

## Other gotchas

- **`statusContext` is overwritten in place.** Dunning state is only observable
  live, never historically — which is why the dashboard syncs it every 20
  minutes. You cannot ask Skio "who was in dunning last Tuesday".
- **Reconstructed historical "active subs" overstate by ~15%**, because the
  dunning exclusion depends on `lastBillingAttemptAt`.
- **`permanentlyCancel: true` is rejected** by the public API.
- **Three cancel-flow schema versions coexist.** Query all three or you will
  silently miss sessions.
- Pagination is Hasura offset-style, page size 500-1000, and needs a stable
  `order_by` or rows will be skipped and duplicated. `paginate()` in
  `/home/app/kit/lib/skio.ts` handles this.

## Scale

~11,600 subscriptions; a full pull takes about 12 minutes. Cache it — the
helpers in `/home/app/kit/lib/cache.ts` write to `/home/app/workspace/cache/`. Don't re-pull the
base for a follow-up question.
