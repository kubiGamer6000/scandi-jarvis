# ShopifyQL recipes

Annotated patterns for the most common ShopifyQL requests. When a user asks for something that matches one of these shapes, start from the recipe and tweak — it is faster than building from scratch and the patterns embed best practices for time handling, totals, and visualization.

## Table of contents

### Sales reporting
- [Top products in a time window](#top-products-in-a-time-window)
- [Sales by product variant](#sales-by-product-variant)
- [Daily sales trend with backfill](#daily-sales-trend-with-backfill)
- [Sales performance by period (multi-metric)](#sales-performance-by-period-multi-metric)
- [Year-over-year sales with weekday alignment](#year-over-year-sales-with-weekday-alignment)
- [Cumulative sales over a period](#cumulative-sales-over-a-period)
- [Sales by hour of day / day of week](#sales-by-hour-of-day--day-of-week)
- [BFCM comparison](#bfcm-comparison)

### Geographic and channel breakdowns
- [Regional breakdown with totals](#regional-breakdown-with-totals)
- [Sales by channel](#sales-by-channel)

### Order and discount analysis
- [Average order value by month](#average-order-value-by-month)
- [Discount-code performance](#discount-code-performance)

### Customer analysis
- [New vs returning customers over time](#new-vs-returning-customers-over-time)
- [Top spending customers (lifetime)](#top-spending-customers-lifetime)
- [VIP segment via `MATCHES`](#vip-segment-via-matches)
- [Lapsed customers (engaged but not buying)](#lapsed-customers-engaged-but-not-buying)
- [RFM grid](#rfm-grid)

### Conversion and traffic
- [Conversion funnel by product](#conversion-funnel-by-product)
- [Site-wide conversion trend](#site-wide-conversion-trend)

### Multi-store
- [Sales by store across the organization](#sales-by-store-across-the-organization)
- [Single-currency rollup across stores](#single-currency-rollup-across-stores)

### Comparison and benchmarking
- [This month vs previous month with percent change](#this-month-vs-previous-month-with-percent-change)
- [Comparison against industry benchmarks](#comparison-against-industry-benchmarks)

---

## Sales reporting

### Top products in a time window

```shopifyql
FROM sales
  SHOW total_sales, product_title
  GROUP BY product_title
  SINCE -30d
  ORDER BY total_sales DESC
  LIMIT 10
VISUALIZE total_sales TYPE bar
```

Why: a `bar` visualization with `LIMIT 10` is the most readable shape for "top N" reports.

### Sales by product variant

```shopifyql
FROM sales
  SHOW total_sales, units_sold, variant_title, product_title
  GROUP BY variant_title, product_title
  SINCE -7d
  ORDER BY total_sales DESC
  LIMIT 25
```

Why: variant titles ("Large / Black") are meaningless without the parent product, so include `product_title` for readability. Both must appear in `GROUP BY` because they appear in `SHOW`. If the column is rejected, retry with `product_variant_title`.

### Daily sales trend with backfill

```shopifyql
FROM sales
  SHOW total_sales
  TIMESERIES day
  DURING last_month
VISUALIZE total_sales TYPE line
```

Why: `TIMESERIES day` (not `GROUP BY day`) backfills empty days with zero so the line chart does not skip dates.

### Sales performance by period (multi-metric)

```shopifyql
FROM sales
  SHOW gross_sales, net_sales, total_sales, orders
  TIMESERIES month
  SINCE startOfYear(-1y) UNTIL today
  ORDER BY month
```

Why: showing `gross_sales`, `net_sales`, and `total_sales` side-by-side highlights the impact of discounts, returns, taxes, and shipping. `startOfYear(-1y)` snaps to Jan 1 of last year for clean year-on-year comparisons.

### Year-over-year sales with weekday alignment

```shopifyql
FROM sales
  SHOW total_sales
  TIMESERIES day
  SINCE -7d
  COMPARE TO previous_year_match_day_of_week
```

Why: `previous_year_match_day_of_week` shifts back 52 weeks instead of one calendar year, which keeps weekdays aligned. This is critical for retail seasonality where weekend vs weekday patterns dominate.

### Cumulative sales over a period

```shopifyql
FROM sales
  SHOW net_sales
  TIMESERIES day WITH CUMULATIVE_VALUES
  DURING last_month
```

Why: `WITH CUMULATIVE_VALUES` adds a `net_sales__cumulative` column that tracks running total per day. Only additive metrics qualify — do not try this with `average_order_value` or `conversion_rate`.

### Sales by hour of day / day of week

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY hour_of_day, day_of_week
  SINCE -90d
VISUALIZE total_sales TYPE heatmap
```

Why: cyclical dimensions (`hour_of_day`, `day_of_week`) plus a `heatmap` reveal "when do customers buy" patterns. Both are zero-based — `day_of_week = 0` is Monday.

### BFCM comparison

```shopifyql
FROM sales
  SHOW total_sales, orders, units_sold
  TIMESERIES day
  DURING bfcm2024
  COMPARE TO bfcm2023
```

Why: `bfcmYYYY` is a built-in named range covering the Black Friday / Cyber Monday window. Pair with `COMPARE TO bfcm2023` to get prior-year context without computing dates manually.

---

## Geographic and channel breakdowns

### Regional breakdown with totals

```shopifyql
FROM sales
  SHOW total_sales
  WHERE billing_country IN ('United States', 'Canada')
  GROUP BY billing_country, billing_region WITH TOTALS, GROUP_TOTALS
  ORDER BY total_sales DESC
```

Why: `WITH TOTALS, GROUP_TOTALS` adds both a grand total and a per-country subtotal, which is what executives expect on a regional report.

### Sales by channel

```shopifyql
FROM sales
  SHOW total_sales, orders
  GROUP BY sales_channel
  DURING this_quarter
  ORDER BY total_sales DESC
```

---

## Order and discount analysis

### Average order value by month

```shopifyql
FROM sales
  SHOW total_sales / orders AS avg_order_value, orders
  TIMESERIES month
  SINCE -12m UNTIL today
VISUALIZE avg_order_value TYPE line
```

Why: AOV is a derived metric — express it inline with `/`. Include `orders` so the user can see whether the AOV change comes from spend or volume.

### Discount-code performance

```shopifyql
FROM sales
  SHOW total_sales, orders, discounts, discount_code
  WHERE discount_code IS NOT NULL
  GROUP BY discount_code
  DURING last_month
  ORDER BY total_sales DESC
```

---

## Customer analysis

### New vs returning customers over time

```shopifyql
FROM customers
  SHOW new_customers, returning_customers
  TIMESERIES week
  SINCE -12w UNTIL today
VISUALIZE new_customers, returning_customers TYPE stacked_area
```

Why: `stacked_area` makes the mix between acquisition and retention visually obvious. `TIMESERIES week` backfills missing weeks.

### Top spending customers (lifetime)

```shopifyql
FROM customers
  SHOW customer_name, customer_email, total_amount_spent, total_orders
  GROUP BY customer_name, customer_email
  ORDER BY total_amount_spent DESC
  LIMIT 50
```

### VIP segment via `MATCHES`

```shopifyql
FROM customers
  SHOW customer_email, total_amount_spent
  WHERE orders_placed MATCHES (date > '2025-01-01', count >= 5)
  ORDER BY total_amount_spent DESC
```

Why: `MATCHES` does the semi-join against `orders_placed`. Each parameter (`date`, `count`) appears once — repeating `date` would invalidate the filter.

### Lapsed customers (engaged but not buying)

```shopifyql
FROM customers
  SHOW customer_email
  WHERE shopify_email.opened MATCHES (date > '2025-08-01')
    AND orders_placed NOT MATCHES (date > '2025-08-01')
```

Why: useful list for re-engagement campaigns. Combines `MATCHES` and `NOT MATCHES` against different semi-join expressions.

### RFM grid

```shopifyql
FROM customers
  SHOW customers
VISUALIZE customers TYPE rfm_grid
```

Why: `rfm_grid` is a specialized visualization that segments customers by Recency, Frequency, and Monetary value automatically — useful for marketing segmentation reports.

---

## Conversion and traffic

### Conversion funnel by product

```shopifyql
FROM sessions
  SHOW sessions, product_views, add_to_carts, checkouts, orders
  GROUP BY product_title
  HAVING orders > 0
  ORDER BY sessions DESC
  LIMIT 20
VISUALIZE sessions, product_views, add_to_carts, checkouts, orders TYPE funnel
```

Why: `HAVING orders > 0` filters out products that get traffic but never convert (often noise). The metric order in `VISUALIZE` defines the funnel order.

### Site-wide conversion trend

```shopifyql
FROM sessions, sales
  SHOW day, sessions, orders, total_sales
  GROUP BY day
  SINCE -30d
VISUALIZE orders TYPE line
```

Why: `FROM sessions, sales` implicit-joins on `day` (which appears in `GROUP BY`). If the user wants an explicit conversion rate, add `orders / sessions AS conversion_rate` to `SHOW`.

---

## Multi-store

### Sales by store across the organization

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales, orders
  GROUP BY shop_name
  DURING last_month
  ORDER BY total_sales DESC
```

Why: `FROM ORGANIZATION` aggregates across the whole portfolio; `GROUP BY shop_name` breaks it down per store.

### Single-currency rollup across stores

```shopifyql
FROM ORGANIZATION sales
  SHOW total_sales
  WHERE shop_id IN (10002, 20023, 24211)
  GROUP BY shop_name
  WITH CURRENCY 'USD', TIMEZONE 'America/New_York'
```

Why: stores in different markets report in different currencies and timezones by default. `WITH CURRENCY` and `WITH TIMEZONE` normalize them for comparison.

---

## Comparison and benchmarking

### This month vs previous month with percent change

```shopifyql
FROM sales
  SHOW total_sales, product_title
  GROUP BY product_title WITH PERCENT_CHANGE
  DURING this_month
  COMPARE TO previous_month
  ORDER BY total_sales DESC
  LIMIT 10
```

Why: `WITH PERCENT_CHANGE` adds a percent-change column for each metric, which is the readable form of period-over-period analysis.

### Comparison against industry benchmarks

```shopifyql
FROM sales
  SHOW total_sales
  TIMESERIES day
  SINCE startOfDay(-30d) UNTIL today
  COMPARE TO benchmarks
VISUALIZE total_sales TYPE line
```

Why: `COMPARE TO benchmarks` overlays Shopify's industry benchmark series for supported metrics. This is only meaningful for metrics Shopify has benchmarks for — if the field is rejected, fall back to `COMPARE TO previous_year`.
