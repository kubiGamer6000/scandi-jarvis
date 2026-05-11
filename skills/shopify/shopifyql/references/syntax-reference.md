# ShopifyQL syntax reference

Comprehensive keyword-by-keyword reference for ShopifyQL. Use this when SKILL.md is not specific enough — for example, when designing a complex query, when a `parseErrors` message names a keyword, or when the user asks about a specific feature.

## Table of contents

1. [Core syntax rules](#core-syntax-rules)
2. [`FROM` and `SHOW`](#from-and-show)
3. [`WHERE`](#where)
4. [`MATCHES` and semi-joins](#matches-and-semi-joins)
5. [`GROUP BY`](#group-by)
6. [`TIMESERIES`](#timeseries)
7. [`HAVING`](#having)
8. [`SINCE` and `UNTIL`](#since-and-until)
9. [`DURING` and named ranges](#during-and-named-ranges)
10. [`COMPARE TO` and benchmarks](#compare-to-and-benchmarks)
11. [`ORDER BY`](#order-by)
12. [`LIMIT` and `OFFSET`](#limit-and-offset)
13. [`WITH` modifiers](#with-modifiers)
14. [`VISUALIZE` and `TYPE`](#visualize-and-type)
15. [`AS` (aliases)](#as-aliases)
16. [`TOP N`](#top-n)
17. [Mathematical operators](#mathematical-operators)
18. [Implicit joins](#implicit-joins)
19. [Multi-store reporting (`FROM ORGANIZATION`)](#multi-store-reporting-from-organization)
20. [Metafields](#metafields)
21. [Comments](#comments)
22. [Segment query language (subset)](#segment-query-language-subset)

---

## Core syntax rules

A query must include `FROM` and `SHOW`. Other keywords are optional but must follow this strict sequence:

1. `FROM`
2. `SHOW`
3. `WHERE`
4. `SINCE`/`UNTIL` **or** `DURING`
5. `GROUP BY`
6. `TIMESERIES`
7. `COMPARE TO`
8. `HAVING`
9. `ORDER BY`
10. `LIMIT`
11. `WITH` (`TOTALS`, `GROUP_TOTALS`, `PERCENT_CHANGE`, `CUMULATIVE_VALUES`, `CURRENCY`, `TIMEZONE`)
12. `VISUALIZE` and `TYPE`

**Formatting convention:** `FROM` and `VISUALIZE` are top-level. Every other keyword is indented two spaces under `FROM`.

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

## `FROM` and `SHOW`

`FROM` selects the dataset table(s); `SHOW` selects the metrics and dimensions to return. The simplest valid query uses just these two:

```shopifyql
FROM sales
  SHOW total_sales
```

You can comma-separate tables for implicit joins (see [Implicit joins](#implicit-joins)).

---

## `WHERE`

Filters by **dimensions** *before* aggregation. `WHERE` does not accept metrics; use `HAVING` for those.

String literals must be wrapped in single quotes:

```shopifyql
FROM sales
  SHOW total_sales, product_title, product_type, product_vendor
  WHERE billing_country = 'Canada'
  GROUP BY product_title, product_type, product_vendor
```

### Comparison operators

`=`, `!=`, `<`, `>`, `<=`, `>=`

### Logical operators

`AND`, `OR`, `NOT`

### String matching

`STARTS WITH`, `ENDS WITH`, `CONTAINS`

```shopifyql
FROM products
  SHOW product_title
  WHERE product_title CONTAINS 'shirt'
    AND product_vendor STARTS WITH 'Nike'
```

### `IN` / `NOT IN`

```shopifyql
WHERE billing_country IN ('United States', 'Canada', 'Mexico')
```

### `IS NULL` / `IS NOT NULL`

```shopifyql
WHERE product_type IS NOT NULL
```

---

## `MATCHES` and semi-joins

Use `MATCHES` (and `NOT MATCHES`) to filter for collections of related entities — typically used to filter a `customers` query by what customers did or received.

Syntax: `WHERE <expression> MATCHES (<parameter_list>)`

**Each parameter can appear only once per `MATCHES` filter.** For example, `MATCHES (date > '2025-01-01', date < '2025-06-01')` is **invalid** because `date` is used twice. Use a single bound, restructure into two clauses, or use the available `count`/`sum_amount` parameters instead.

### Examples

Filter by recent order activity:

```shopifyql
FROM customers
  SHOW customer_email, total_orders
  WHERE orders_placed MATCHES (date > '2025-01-01')
```

Filter by email engagement:

```shopifyql
FROM customers
  SHOW customer_email, email_subscription_status
  WHERE shopify_email.opened MATCHES (activity_id = 5240029206, date > '2025-01-01')
```

Exclude customers who bought recently:

```shopifyql
FROM customers
  SHOW customer_email
  WHERE products_purchased NOT MATCHES (date > '2025-01-01')
```

### Available semi-join expressions

| Expression | Parameters |
| --- | --- |
| `products_purchased` | `id`, `tag`, `category`, `date`, `sum_quantity`, `count` |
| `orders_placed` | `date`, `amount`, `location_id`, `app_id`, `count`, `sum_amount` |
| `shopify_email.opened` | `activity_id`, `date`, `count` |
| `shopify_email.clicked` | `activity_id`, `date`, `count` |
| `shopify_email.bounced` | `activity_id`, `date`, `count` |
| `shopify_email.marked_as_spam` | `activity_id`, `date`, `count` |
| `shopify_email.unsubscribed` | `activity_id`, `date`, `count` |
| `storefront.product_viewed` | `id`, `date`, `count` |
| `storefront.collection_viewed` | `id`, `date`, `count` |
| `store_credit_accounts` | `currency`, `balance`, `next_expiry_date`, `last_credit_date` |
| `customer_within_distance` | `coordinates`, `distance_km` or `distance_mi` |

---

## `GROUP BY`

Segments metrics by dimensions. **Any dimension that appears in `SHOW` must also appear in `GROUP BY`.**

```shopifyql
FROM sales
  SHOW billing_country, billing_region, total_sales
  GROUP BY billing_country, billing_region
```

### Time-dimension grouping

Acceptable units inside `GROUP BY` (also valid in `TIMESERIES`):

`second`, `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`, `hour_of_day`, `day_of_week`, `week_of_year`, `month_of_year`

The cyclical units are **zero-based**:

- `hour_of_day`: 0–23
- `day_of_week`: 0 = Monday, 1 = Tuesday, …, 6 = Sunday
- `week_of_year`: 1–53
- `month_of_year`: 1–12

If you want missing buckets backfilled with zeros, prefer `TIMESERIES <unit>` over `GROUP BY <unit>`.

---

## `TIMESERIES`

Like `GROUP BY` for a time dimension, but also **backfills empty buckets** with zeros so charts and reports do not skip days. Almost every time-series report should use this rather than `GROUP BY day`.

```shopifyql
FROM sales
  SHOW total_sales
  TIMESERIES month
  SINCE last_year UNTIL today
```

Same valid units as `GROUP BY` time dimensions.

---

## `HAVING`

Filters by **metrics** *after* aggregation. Requires `GROUP BY` or `TIMESERIES`. Unlike `WHERE`, `HAVING` can reference aliases and aggregate expressions.

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY product_title
  HAVING total_sales > 1000
    AND total_sales < 5000
```

---

## `SINCE` and `UNTIL`

Filter by an explicit time range. If `SINCE` has no `UNTIL`, the range ends today.

```shopifyql
FROM sales
  SHOW net_sales
  WHERE billing_country = 'Canada'
  GROUP BY month
  SINCE -12m UNTIL yesterday
```

### Offset literals

| Suffix | Unit |
| --- | --- |
| `s` | seconds |
| `min` | minutes |
| `h` | hours |
| `d` | days |
| `w` | weeks |
| `m` | months |
| `q` | quarters |
| `y` | years |

So `-7d`, `-12w`, `-3m`, `-1q`, `-2y` are all valid.

### Absolute dates

`'yyyy-MM-dd'`, e.g. `SINCE '2025-01-01' UNTIL '2025-03-31'`.

### Anchor functions

Snap a date to the start of a calendar period and optionally apply an offset:

- `startOfDay()`
- `startOfWeek()`
- `startOfMonth()`
- `startOfQuarter()`
- `startOfYear()`

Example — sales since the start of last month:

```shopifyql
SINCE startOfMonth(-1m) UNTIL today
```

---

## `DURING` and named ranges

Convenience for common ranges; replaces a `SINCE`/`UNTIL` pair.

```shopifyql
FROM sales
  SHOW total_sales
  DURING last_month
```

### Available named ranges

`today`, `yesterday`, `this_week`, `last_week`, `this_weekend`, `last_weekend`, `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`, `last_year`, `bfcmYYYY` (e.g. `bfcm2024`).

`DURING` and `SINCE`/`UNTIL` are mutually exclusive in a single query.

---

## `COMPARE TO` and benchmarks

Compares the primary range against another period. Common options:

- `previous_period` — the immediately preceding range of equal length.
- `previous_year` — same calendar dates one year ago.
- `previous_month` — same calendar dates one month ago.
- `this_month`, `last_month` — relative.
- `previous_year_match_day_of_week` — shifted back 52 weeks so weekdays align. Use this for retail seasonality where weekday patterns matter (Black Friday, weekend categories, etc.).
- `benchmarks` — Shopify's industry benchmark series, available for supported metrics within reports.

### Examples

Year-over-year sales:

```shopifyql
FROM sales
  SHOW net_sales, product_title
  GROUP BY product_title
  TIMESERIES day
  SINCE -1m UNTIL 0m
  COMPARE TO previous_year
```

Weekday-aligned year-over-year:

```shopifyql
FROM sales
  SHOW total_sales
  TIMESERIES day
  SINCE -7d
  COMPARE TO previous_year_match_day_of_week
```

Compare against industry benchmarks:

```shopifyql
FROM sales
  SHOW total_sales
  TIMESERIES day
  SINCE startOfDay(-30d) UNTIL today
  COMPARE TO benchmarks
VISUALIZE total_sales TYPE line
```

Pair with `WITH PERCENT_CHANGE` to add explicit percent-change columns.

---

## `ORDER BY`

Sort by one or more columns. `ASC` ascending (default), `DESC` descending.

```shopifyql
FROM sales
  SHOW net_sales
  GROUP BY product_title, product_type
  ORDER BY product_title, product_type DESC
```

You can sort by a metric, a dimension, or an alias declared with `AS`.

---

## `LIMIT` and `OFFSET`

Restricts returned rows. Default is **1000**. Optional `OFFSET` skips rows for pagination.

```shopifyql
FROM sales
  SHOW gross_sales AS total_gross_sales
  GROUP BY product_title
  ORDER BY total_gross_sales DESC
  LIMIT 10
```

```shopifyql
LIMIT 50 OFFSET 100
```

---

## `WITH` modifiers

`WITH` modifies the behavior of a preceding clause. Multiple modifiers are comma-separated.

| Modifier | Effect |
| --- | --- |
| `TOTALS` | Adds a top-level grand-total row before the dimensional breakdown. |
| `GROUP_TOTALS` | Adds subtotals per group when `GROUP BY` is nested. |
| `PERCENT_CHANGE` | Adds percent-change columns for each metric when used with `COMPARE TO`. |
| `CUMULATIVE_VALUES` | Adds running-total columns named `<metric>__cumulative` for additive metrics. Requires time order. |
| `CURRENCY 'XXX'` | Renders monetary metrics in a specific currency (three-letter ISO code). |
| `TIMEZONE 'Region/City'` | Renders time-bucketed data in a specific IANA timezone. |

### Examples

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY billing_region WITH TOTALS
```

```shopifyql
FROM sales
  SHOW net_sales
  TIMESERIES day WITH CUMULATIVE_VALUES
  DURING last_month
```

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales
  WITH CURRENCY 'USD', TIMEZONE 'America/New_York'
```

### `CUMULATIVE_VALUES` rules

`WITH CUMULATIVE_VALUES` produces columns named `<metric>__cumulative` (double underscore + `cumulative`).

- **Eligible** (additive over time): `net_sales`, `gross_sales`, `orders`, `units_sold`, `customers`, `sessions`, `revenue`, `taxes`, `shipping`, `discounts`, `sales_reversals`.
- **Ineligible** (ratios that do not sum sensibly over time): `average_order_value`, `conversion_rate`, `cart_abandonment_rate`, `growth_rate`.

Result shape:

| day | net_sales | net_sales__cumulative |
| --- | --- | --- |
| 2024-12-01 | $1,200.00 | $1,200.00 |
| 2024-12-02 | $950.00 | $2,150.00 |
| 2024-12-03 | $1,400.00 | $3,550.00 |

Requires `TIMESERIES` or `ORDER BY <time>` to establish ordering.

---

## `VISUALIZE` and `TYPE`

Renders the result as a chart. If `TYPE` is omitted, ShopifyQL chooses a sensible default. `MAX N` limits how many data points are drawn (use this for top-N visuals so the chart stays legible).

```shopifyql
FROM sales
  SHOW gross_sales
  TIMESERIES month
VISUALIZE gross_sales TYPE line
```

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY product_title
VISUALIZE total_sales TYPE bar MAX 5
```

### Supported visualization types

| Type | Description |
| --- | --- |
| `bar` | Vertical bar chart |
| `horizontal_bar` | Horizontal bar chart |
| `grouped_bar` | Grouped vertical bars |
| `horizontal_grouped_bar` | Grouped horizontal bars |
| `stacked_bar` | Stacked vertical bars |
| `stacked_horizontal_bar` | Stacked horizontal bars |
| `single_stacked_bar` | Single stacked bar |
| `line` | Line chart |
| `stacked_area` | Stacked area chart |
| `histogram` | Histogram distribution |
| `donut` | Circular chart with center hole |
| `funnel` | Step-by-step view through a process |
| `heatmap` | Two-dimensional grid |
| `single_metric` | Single metric display |
| `list` | List display |
| `list_with_dimension_values` | List with dimension values |
| `table` | Tabular data |
| `rfm_grid` | RFM (Recency, Frequency, Monetary) segmentation grid |
| `target_gauge` | Gauge showing progress toward an analytics target |

### Visualization modifiers

- `MAX N` — limits the number of data points displayed.
- `LIMIT N` — deprecated alias for `MAX`; prefer `MAX`.

---

## `AS` (aliases)

Renames a column. Aliases that contain spaces or special characters must be wrapped in **double quotes** (the only place double quotes are valid in ShopifyQL).

```shopifyql
FROM sales
  SHOW total_sales AS "My Total Sales"
```

Aliases declared with `AS` can be referenced from `HAVING` and `ORDER BY`.

---

## `TOP N`

Used inside `GROUP BY` to keep the N largest values per dimension and roll the rest into an "Other" bucket.

```shopifyql
FROM sales
  SHOW gross_sales
  GROUP BY day, TOP 5 product_title
  TIMESERIES day
  SINCE startOfDay(-30d) UNTIL today
```

### Modifiers

- `ONLY TOP N` — drops the "Other" bucket entirely.
- `TOP N OVERALL` — ranks across the whole result, not per outer group.

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY ONLY TOP 3 product_title OVERALL, TOP 3 shipping_country
```

---

## Mathematical operators

Perform arithmetic on metrics inside `SHOW`: `+`, `-`, `*`, `/`. Wrap expressions in parentheses for clarity.

```shopifyql
FROM sales
  SHOW (net_sales + sales_reversals) AS order_value, orders
  GROUP BY billing_region
```

Useful for derived metrics like `total_sales / orders AS avg_order_value`.

---

## Implicit joins

Comma-separate tables in `FROM` to query across them. ShopifyQL implicit-joins on dimensions that exist in both tables and are present in `GROUP BY`. The shared dimension(s) **must** appear in `GROUP BY`.

```shopifyql
FROM sales, sessions
  SHOW day, total_sales, sessions
  GROUP BY day
```

Common cross-table dimensions: `day` and other time units, `product_title`, `product_id`, `shop_id`/`shop_name` (multi-store), customer identifiers.

---

## Multi-store reporting (`FROM ORGANIZATION`)

Organizations with multiple stores can query across the whole portfolio:

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales
```

Break down by store with `shop_name`:

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales
  GROUP BY shop_name
```

Filter to specific stores with `shop_id`:

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales
  WHERE shop_id IN (10002, 20023, 24211)
  GROUP BY shop_name
```

By default, multi-store queries use the current store's currency and timezone. Override with `WITH CURRENCY` and `WITH TIMEZONE`:

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales
  WITH CURRENCY 'USD', TIMEZONE 'America/New_York'
```

---

## Metafields

Custom metafields can be referenced in `WHERE`, `GROUP BY`, and `SHOW` clauses.

### Requirements

The metafield must have a [metafield definition](https://shopify.dev/docs/apps/build/custom-data/metafields/definitions) with `use_in_analytics` enabled.

### Supported owner types

`customer`, `order`, `product`, `product_variant`

### Supported metafield types

**Scalar:** `single_line_text_field`, `multi_line_text_field`, `number_integer`, `number_decimal`, `date`, `date_time`, `url`, `boolean`, `color`, `id`, `product_reference`, `rating`

**List:** `list.single_line_text_field`, `list.multi_line_text_field`, `list.number_integer`, `list.number_decimal`

### Reference syntax

```
<owner_type>.metafields.<namespace>.<key>
```

E.g. `customer.metafields.custom.membership_level`.

### Examples

Filter by metafield:

```shopifyql
FROM customers
  SHOW customer_name, total_amount_spent
  WHERE customer.metafields.custom.membership_level = 'gold'
  GROUP BY customer_name
```

Group by metafield:

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY product.metafields.custom.category
```

Combine metafields across owner types:

```shopifyql
FROM sales
  SHOW total_sales
  WHERE customer.metafields.custom.vip = true
    AND product.metafields.reviews.rating > 4
  GROUP BY product_title
```

---

## Comments

Single-line:

```shopifyql
-- This is a comment
FROM sales
  SHOW total_sales
```

Block:

```shopifyql
/* Multi-line
   comment */
FROM sales
  SHOW total_sales
```

`#` is **not** a valid comment marker.

---

## Segment query language (subset)

Shopify also exposes a separate "segment query language" — a strict subset of ShopifyQL that uses only the `WHERE` clause to define a customer segment. The customers matching the filter are the segment members.

If the user is creating a customer segment in the admin (rather than a report), they need this subset rather than full ShopifyQL. The full reference lives in the [segment query language reference](https://shopify.dev/docs/api/shopifyql/segment-query-language-reference) on shopify.dev. Most semi-join expressions documented above (`orders_placed`, `products_purchased`, `shopify_email.*`, `storefront.*`, `store_credit_accounts`, `customer_within_distance`) come from this subset and are particularly useful for segments.
