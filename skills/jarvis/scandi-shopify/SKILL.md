---
name: scandi-shopify
description: Queries Scandi Gum's Shopify store for sales, orders, products, customers and fulfilment. Use when the user asks about sales of a specific product or SKU, order counts, AOV, returns, discounts, a specific order or customer, fulfilment or delivery status, or wants non-subscription (one-time) sales separated from subscription rebills. Also use for any Shopify analytics question that needs a breakdown by product, market, channel or date.
---

# Shopify

Source of truth for revenue, orders, customers and fulfilment. Store is
`5jdtfm-9p.myshopify.com`, currency EUR, timezone Europe/Stockholm, API version
`2026-01`.

**Before writing anything here:** if the question is about total revenue,
profit or blended performance, the `scandi-profit-api` skill already has the
answer with the precedence rules applied. Come here for **breakdowns and
individual records** — per product, per market, per order.

## Which of the two tools

```bash
# Aggregates, breakdowns, trends → ShopifyQL. Start here.
tsx /home/app/skills/jarvis/scandi-shopify/scripts/query.ts ql "FROM sales SHOW total_sales, orders SINCE 2026-08-01 UNTIL 2026-08-31"

# Individual records, line items, fulfilment → GraphQL.
tsx /home/app/skills/jarvis/scandi-shopify/scripts/query.ts orders --search "created_at:>=2026-08-01" --limit 50
tsx /home/app/skills/jarvis/scandi-shopify/scripts/query.ts gql "{ shop { name } }"
```

Add `--csv /home/app/workspace/out.csv` to any command to write a file instead of printing.

**Use ShopifyQL for anything aggregate.** It is what the platform is built for,
and it is far faster than paginating orders and summing them yourself. For
syntax, load the **`shopifyql`** skill — don't guess the grammar, it is
idiosyncratic. For GraphQL schema questions, load **`shopify-admin`** (its
`search_docs.mjs` / `validate.mjs` scripts check the schema and validate a query).

## Subscription vs one-time sales

**Order tags are the only reliable signal.** There is no product-level
subscription flag. This matters constantly, because "how did product X sell?"
almost always means *excluding* rebills.

| Meaning | Tags |
|---|---|
| Rebills | `Subscription Recurring Order`, `Subscription Order: 2`, `Subscription Order: 3` |
| First subscription order | `Subscription First Order` |

`Subscription Order: 2` is the **second** charge, not the second month —
Skio's `cyclesCompleted` counts the checkout as cycle 1.

```sql
-- One-time sales only
FROM sales SHOW total_sales, orders
WHERE NOT (order_tags CONTAINS 'Subscription Recurring Order'
        OR order_tags CONTAINS 'Subscription First Order')
SINCE 2026-08-01 UNTIL 2026-08-31
```

The script exposes these as presets so the tag list stays in one place:

```bash
tsx /home/app/skills/jarvis/scandi-shopify/scripts/query.ts sales --days 30 --split
```

## Gotchas that produce wrong answers

- **Every ShopifyQL value arrives as a string.** Cast before arithmetic. The
  script does this for you via `rowsToObjects`.
- **`average_order_value` from ShopifyQL is only valid for a single day.** It
  cannot be summed or averaged across a range. Compute
  `SUM(total_sales) / SUM(orders)` instead.
- **On API 2026-01, bulk operations default to `groupObjects: false`.** Line
  items and fulfilments arrive as **flat rows carrying `__parentId`**, not
  nested. You must reassemble them. This has broken multiple scripts.
- **`displayFulfillmentStatus` (order level) and per-fulfilment `displayStatus`
  can disagree.** Check both when fulfilment matters.
- **`deliveredAt` is unreliable** — not every carrier reports it. Shopify first
  (free), then 17track (metered).
- **Order counts drift on past days** even when revenue is stable. Don't treat
  a small change as a bug.

## Rate limiting

Handled in `/home/app/kit/lib/shopify.ts`: leaky-bucket awareness, 429 and `THROTTLED`
retries, 5xx retries with exponential backoff, six attempts, and a proactive
pause when the bucket lacks credits for the next page. If you write a custom
pull, import `graphql()` from there rather than calling `fetch` — you get all
of that for free.

Auth is handled by the credential gateway — no token or key is in the sandbox.
Access is **read-only**: GraphQL queries go through, mutations are refused. If a
call fails with a gateway error, report the error text to the user.
