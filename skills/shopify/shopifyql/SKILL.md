---
name: shopifyql
description: Author, debug, and run ShopifyQL queries against the Shopify Admin GraphQL API (the `shopifyqlQuery` endpoint) to build analytics reports, customer segments, and store performance dashboards. Use this skill whenever the user wants to query, report on, or analyze data from a Shopify store — sales, orders, products, customers, or sessions — including casual asks like "show me top sellers last week", "compare this month's revenue to last year", "sales by product variant in the last 7 days", regional breakdowns, conversion funnels, customer cohorts, time-series trends, year-over-year comparisons, BFCM reporting, or building a custom analytics dashboard. Trigger on any mention of ShopifyQL, `shopifyqlQuery`, `FROM`/`SHOW`/`GROUP BY`/`TIMESERIES` syntax, or "report on" / "break down by" / "trend of" / "top N" requests against a Shopify store — even when the user does not explicitly say "ShopifyQL".
---

# ShopifyQL: building reports against the Admin API

ShopifyQL is Shopify's commerce query language exposed through the Admin GraphQL `shopifyqlQuery` endpoint. It looks SQL-ish but it is **not** SQL — it has its own strict keyword order, its own metric/dimension catalog, and its own time-series sugar. Almost every broken ShopifyQL query is broken because of one of those three things.

This skill walks through how to design a query end-to-end, calls out the rules that bite, and points to deeper notes for syntax, data, recipes, and the GraphQL wiring.

---

## How to approach a request

Work through these steps in order. They turn an English question into a valid query without backtracking.

1. **Restate the question in business terms.** What is the *metric* (the number being measured)? What *dimensions* break it down? What *time range*? Any *filters*? Any *comparison* to another period? Doing this once up front avoids rewrites.
2. **Pick the table(s) for `FROM`.** One of `sales`, `orders`, `products`, `customers`, `sessions`. For cross-table reports (e.g. sales + sessions for conversion), comma-separate them — ShopifyQL implicit-joins on shared dimensions you place in `GROUP BY`. For multi-store rollups use `FROM ORGANIZATION <table>`.
3. **Classify each column as metric or dimension.** Metrics (numeric, aggregable like `total_sales`, `orders`, `units_sold`) go in `SHOW` and `HAVING`. Dimensions (categorical or temporal like `product_title`, `billing_country`, `day`) go in `SHOW`, `WHERE`, and `GROUP BY`. Every dimension that appears in `SHOW` must also appear in `GROUP BY`.
4. **Add the time controls.** Use `DURING` for named ranges (`last_month`, `bfcm2024`); use `SINCE`/`UNTIL` for offsets (`-7d`, `startOfMonth(-1m)`) or absolute dates (`'2025-01-01'`). Use `TIMESERIES` (not just `GROUP BY day`) when you want ShopifyQL to backfill missing dates with zeros, which is almost always what reports want.
5. **Write the query in the required keyword order.** This order is strict; reordering produces parse errors. See [Required keyword order](#required-keyword-order) below.
6. **Wrap it in `shopifyqlQuery` and read `parseErrors`.** A non-empty `parseErrors` array is your debugging trace. Treat it like a compiler error and fix the exact symbol it names. See `references/graphql-integration.md` for the full request/response shape, required scopes, and a debugging loop.

If you are unsure whether a specific column name exists (e.g. is the variant dimension `variant_title`, `product_variant_title`, or `variant_name`?), say so out loud and try the most likely candidate first — `parseErrors` will tell you if it is wrong. The Shopify dev documentation is the authoritative source; `references/data-model.md` lists what is confirmed by the official ShopifyQL docs, and the `shopify-dev` skill (or a Shopify docs search) can resolve fields that are not enumerated there.

---

## Required keyword order

ShopifyQL is a pipeline. Keywords must appear in this sequence; unused ones are skipped, never reordered.

1. `FROM` — required
2. `SHOW` — required
3. `WHERE` — filters by **dimensions** (pre-aggregation)
4. `SINCE` / `UNTIL`, **or** `DURING` (mutually exclusive)
5. `GROUP BY`
6. `TIMESERIES`
7. `COMPARE TO`
8. `HAVING` — filters by **metrics** (post-aggregation); requires `GROUP BY` or `TIMESERIES`
9. `ORDER BY`
10. `LIMIT` (with optional `OFFSET`)
11. `WITH` — `TOTALS`, `GROUP_TOTALS`, `PERCENT_CHANGE`, `CUMULATIVE_VALUES`, `CURRENCY 'USD'`, `TIMEZONE 'America/New_York'`
12. `VISUALIZE … TYPE …` (top-level, outside the `FROM` block)

Standard formatting: `FROM` and `VISUALIZE` are top-level; everything else is indented two spaces under `FROM`.

```shopifyql
FROM sales
  SHOW total_sales
  WHERE billing_country = 'Canada'
  GROUP BY product_title
  SINCE last_month
  ORDER BY total_sales DESC
  LIMIT 10
VISUALIZE total_sales TYPE bar
```

---

## The rules that bite

A handful of constraints are responsible for most query failures. Internalize them:

- **Single quotes only for string literals**: `WHERE billing_country = 'Canada'`. Double quotes are reserved for aliases that contain spaces, e.g. `AS "My Total Sales"`.
- **Dimension in `SHOW` ⇒ dimension in `GROUP BY`.** Without this, the query is invalid.
- **`WHERE` is dimension-only; `HAVING` is metric-only.** `WHERE total_sales > 100` will not parse — use `HAVING total_sales > 100`.
- **`HAVING` requires `GROUP BY` or `TIMESERIES`.** It filters aggregates, so there must be aggregates.
- **`TIMESERIES <unit>` is not the same as `GROUP BY <unit>`.** Both group by time, but `TIMESERIES` also backfills empty buckets with zeros, which is what most reports want.
- **`SINCE`/`UNTIL` and `DURING` are mutually exclusive.** Pick one style per query.
- **Implicit joins need a shared dimension in `GROUP BY`.** `FROM sales, sessions … GROUP BY day` works because both tables expose `day`.
- **Each `MATCHES` parameter can appear only once** per filter — `WHERE orders_placed MATCHES (date > '2025-01-01', date < '2025-06-01')` is invalid because `date` repeats. Use a single bound or restructure.
- **Comments use `--` or `/* … */`** — never `#`.
- **`LIMIT` defaults to 1000.** Bring this down for exploration to keep responses fast and within rate limits.

---

## Time handling at a glance

There are three different time tools and they overlap on purpose. Pick the one that matches intent:

- **`DURING <named_range>`** — easiest. Available named ranges: `today`, `yesterday`, `this_week`, `last_week`, `this_weekend`, `last_weekend`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`, `last_year`, and `bfcm{YYYY}` (e.g. `bfcm2024`).
- **`SINCE` / `UNTIL`** — explicit. Accepts:
  - Offset literals: `-7d`, `-12w`, `-3m`, `-1q`, `-1y`, plus `s`, `min`, `h` for sub-day.
  - Absolute dates: `'yyyy-MM-dd'`.
  - Anchor functions: `startOfDay()`, `startOfWeek()`, `startOfMonth()`, `startOfQuarter()`, `startOfYear()`, each accepting an offset, e.g. `startOfMonth(-1m)`.
  - Omitting `UNTIL` ends the range at today.
- **`TIMESERIES <unit>`** — groups by time *and* backfills empty buckets. Units: `second`, `minute`, `hour`, `hour_of_day`, `day`, `day_of_week`, `week`, `week_of_year`, `month`, `month_of_year`, `quarter`, `year`. The cyclical units (`hour_of_day`, `day_of_week`, etc.) are zero-based and great for spotting "time of day" patterns.

For period-over-period analysis, add `COMPARE TO`:

- `previous_period` — the immediately preceding range of equal length.
- `previous_year` / `previous_month` — same calendar dates shifted.
- `previous_year_match_day_of_week` — shifted back 52 weeks so weekdays align. Use this for retail seasonality where weekday patterns matter (Black Friday, weekend-driven categories, etc.).
- `benchmarks` — Shopify's industry benchmark series for supported metrics.

Pair `COMPARE TO` with `WITH PERCENT_CHANGE` to add explicit percent-change columns to the result.

---

## Top-N, totals, and cumulative values

- **`WITH TOTALS`** adds a grand-total row above the dimensional breakdown.
- **`WITH GROUP_TOTALS`** adds subtotals per group when there are nested `GROUP BY` dimensions.
- **`TOP N` inside `GROUP BY`** keeps the N largest values per dimension and rolls the rest into "Other": `GROUP BY day, TOP 5 product_title`.
  - `ONLY TOP N` drops the "Other" bucket.
  - `TOP N OVERALL` ranks across the full range, not per outer group.
- **`WITH CUMULATIVE_VALUES`** appends `<metric>__cumulative` columns and requires a time order (`TIMESERIES` or `ORDER BY <time>`). Only additive metrics are eligible — ratios like `average_order_value`, `conversion_rate`, `cart_abandonment_rate`, and `growth_rate` are not.

---

## Worked example

> "Create a report that shows our total sales by product variant in the last 7 days."

Walking the workflow:

1. Metric = `total_sales`. Dimension = the variant (best guess `variant_title`; verify via `parseErrors`). Time = last 7 days. No filter, no comparison.
2. `FROM sales` — sales-table data.
3. `total_sales` is a metric → `SHOW`. `variant_title` is a dimension → `SHOW` and `GROUP BY`.
4. Time range: `SINCE -7d` (last 7 days inclusive of today). For a closed window ending yesterday, use `SINCE -7d UNTIL yesterday` instead.
5. Sort biggest sellers first, cap at a reasonable number for a report.

```shopifyql
FROM sales
  SHOW total_sales, variant_title, product_title
  GROUP BY variant_title, product_title
  SINCE -7d
  ORDER BY total_sales DESC
  LIMIT 25
```

`product_title` is included so the report is readable — variant titles like `"Large / Black"` are meaningless without the parent product. Both must appear in `GROUP BY` because they appear in `SHOW`.

To run it through the Admin API:

```graphql
query SalesByVariantLast7Days {
  shopifyqlQuery(
    query: """
      FROM sales
        SHOW net_items_sold, total_sales, variant_title, product_title, sales_reversals
        GROUP BY variant_title, product_title
        SINCE -7d
        ORDER BY total_sales DESC
        LIMIT 25
    """
  ) {
    tableData {
      columns { name dataType displayName }
      rows
    }
    parseErrors { code message }
  }
}
```

If `parseErrors` flags `variant_title` as unknown, retry with `product_variant_title` and surface the change to the user. See `references/graphql-integration.md` for the full debugging loop.

---

## Output expectations

Unless the user asks for something else:

- Return the ShopifyQL query in a fenced block tagged `shopifyql`.
- Format with `FROM` and `VISUALIZE` flush left and every other clause indented two spaces. This matches how Shopify's tools display queries and makes review easier.
- Briefly explain the choices that are not obvious from the query — why `TIMESERIES` instead of `GROUP BY day`, what `previous_year_match_day_of_week` does, why a particular metric was chosen over a similar-sounding one.
- Call out assumptions you made about ambiguous parameters (currency, timezone, store scope, exact date boundary) so the user can correct them.
- If the query is intended to run programmatically, also wrap it in the `shopifyqlQuery` GraphQL call so it is drop-in.
- If you proposed a column name that you are not 100% sure exists, say so and suggest reading `parseErrors` from the first run before trusting the result.

---

## When to read more

These reference files exist so this top-level guide can stay short. Read them as needed:

- **`references/syntax-reference.md`** — every keyword, every operator, every modifier with examples. Read when designing a non-trivial query, when the user asks about a keyword you have not used recently, or when debugging a `parseErrors` message that mentions specific syntax.
- **`references/data-model.md`** — the five tables, their well-known metrics and dimensions, time dimensions, semi-join expressions for `MATCHES`, multi-store fields, and metafield syntax. Read when picking columns or when the user asks "what can I report on?".
- **`references/recipes.md`** — annotated patterns for common asks: top products by period, regional breakdowns, conversion funnels, year-over-year sales, customer cohorts, RFM segmentation, multi-store rollups, BFCM comparisons. Skim first when the request matches a familiar shape — you can often start from a recipe and tweak.
- **`references/graphql-integration.md`** — the GraphQL request/response, required access scopes, complexity-based rate limits, error handling, and a step-by-step debugging loop for `parseErrors`. Read when wiring up code, not when only writing the query.
