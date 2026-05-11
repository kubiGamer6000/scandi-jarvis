# ShopifyQL data model

What you can query, broken down by table. Use this when picking columns for `SHOW`, `WHERE`, or `GROUP BY`, or when the user asks "what data is available?".

> **Source of truth notice.** ShopifyQL exposes far more columns than this file enumerates, and Shopify adds new ones over time. The columns listed here are the ones explicitly documented in the official ShopifyQL docs and patterns observed in their examples. Treat this as a starting point — when you need a column that is not listed (for example, `variant_title` for variant-level reporting), try the most likely name and let `parseErrors` confirm or reject it. The `shopify-dev` skill or `https://shopify.dev/docs/api/shopifyql` is the authoritative source for any column not listed here.

## Table of contents

1. [The five core tables](#the-five-core-tables)
2. [Time dimensions](#time-dimensions)
3. [`sales` table](#sales-table)
4. [`orders` table](#orders-table)
5. [`products` table](#products-table)
6. [`customers` table](#customers-table)
7. [`sessions` table](#sessions-table)
8. [Cross-table dimensions for implicit joins](#cross-table-dimensions-for-implicit-joins)
9. [Multi-store dimensions](#multi-store-dimensions)
10. [Metafields](#metafields)
11. [Semi-join expressions for `MATCHES`](#semi-join-expressions-for-matches)

---

## The five core tables

| Table | Purpose | Typical use |
| --- | --- | --- |
| `sales` | Transactional revenue and units. | Sales reports, top products, regional breakdowns. |
| `orders` | Order-level information and fulfillment. | Order counts, fulfillment status, AOV. |
| `products` | Product catalog and inventory. | Catalog audits, inventory reports. |
| `customers` | Customer profiles and lifetime metrics. | Acquisition, retention, segmentation. |
| `sessions` | Storefront visitor sessions and funnel events. | Conversion, funnel, traffic. |

Use multiple tables in a single `FROM` clause for cross-cutting analysis (e.g. `FROM sales, sessions` for conversion). See [Cross-table dimensions](#cross-table-dimensions-for-implicit-joins).

---

## Time dimensions

Available in every table. Usable in `GROUP BY`, `TIMESERIES`, `ORDER BY`, and (for absolute date columns) `WHERE`.

| Granularity | Dimensions |
| --- | --- |
| Sub-day | `second`, `minute`, `hour` |
| Calendar | `day`, `week`, `month`, `quarter`, `year` |
| Cyclical (zero-based) | `hour_of_day` (0–23), `day_of_week` (0=Mon … 6=Sun) |
| Cyclical (one-based) | `week_of_year` (1–53), `month_of_year` (1–12) |

Cyclical dimensions are perfect for "what time of day do we sell most?" or "which day of week converts best?" patterns.

---

## `sales` table

The most heavily used table for revenue analysis.

### Common metrics

| Metric | Notes |
| --- | --- |
| `total_sales` | Net of returns and discounts; the "headline" sales number. |
| `gross_sales` | Before discounts, returns, taxes, and shipping. |
| `net_sales` | After discounts and returns; before taxes/shipping. |
| `sales_reversals` | Returns and refunds (typically negative). |
| `orders` | Number of orders contributing to the sales. |
| `units_sold` | Total quantity of items sold. |
| `average_order_value` | `net_sales / orders`. **Not** eligible for `WITH CUMULATIVE_VALUES`. |
| `taxes` | Tax revenue collected. |
| `shipping` | Shipping revenue collected. |
| `discounts` | Discount value applied. |
| `revenue` | Aggregate revenue (synonymous with `total_sales` in many contexts). |

### Common dimensions

| Dimension | Notes |
| --- | --- |
| `product_title` | Product name. |
| `product_type` | Product type set in admin. |
| `product_vendor` | Vendor field on a product. |
| `product_id` | Numeric product ID. |
| `variant_title` | Variant name (e.g. `"Large / Black"`). |
| `variant_id` | Numeric variant ID. |
| `variant_sku` | SKU code. |
| `billing_country`, `billing_region`, `billing_city` | Billing address geography. |
| `shipping_country`, `shipping_region`, `shipping_city` | Shipping address geography. |
| `sales_channel` | Online store, POS, app, etc. |
| `customer_id`, `customer_email` | Customer identity. |
| `order_name`, `order_id` | Order identity. |
| `discount_code` | The discount code applied (if any). |

> Variant-level dimensions (`variant_title`, `variant_id`, `variant_sku`) are the typical answer to "by product variant" requests. If `variant_title` does not parse, try `product_variant_title` or check the variant inside an `orders` query.

---

## `orders` table

Order-level metrics, useful when the unit of analysis is the order rather than the line item.

### Common metrics

- `orders` — count of orders.
- `total_amount_spent` — money associated with the order.
- `units_per_order` — derived per-order quantity.
- `discounts`, `taxes`, `shipping` — at the order grain.
- Fulfillment metrics where exposed by the schema.

### Common dimensions

- `order_name`, `order_id`
- `customer_id`, `customer_email`, `customer_name`
- `billing_country`, `billing_region`
- `shipping_country`, `shipping_region`
- `sales_channel`
- `financial_status`, `fulfillment_status` (when present)
- `discount_code`

---

## `products` table

Catalog and inventory information. Best for "what is in our catalog?" reports rather than sales analysis.

### Common metrics

- Inventory counts where exposed.
- Catalog counts (e.g. `products`, distinct counts of `variants`).

### Common dimensions

- `product_title`, `product_type`, `product_vendor`, `product_id`
- `product_status` (active, draft, archived)
- `tags`
- `variant_title`, `variant_sku`, `variant_id`

---

## `customers` table

Customer profiles, lifetime metrics, and segmentation.

### Common metrics

- `customers` — distinct customer count.
- `new_customers` — first-time buyers in the period.
- `returning_customers` — repeat buyers in the period.
- `total_orders` — lifetime order count per customer when grouped by customer.
- `total_amount_spent` — lifetime spend per customer when grouped by customer.
- `average_order_value`

### Common dimensions

- `customer_id`, `customer_email`, `customer_name`
- `email_subscription_status`
- Address fields (when exposed)

### Filtering customers by behavior

The richest filtering for `customers` queries is via [Semi-join expressions for `MATCHES`](#semi-join-expressions-for-matches) — for example, "customers who placed an order in the last 90 days" or "customers who opened a specific email campaign".

---

## `sessions` table

Storefront traffic and funnel events.

### Common metrics

- `sessions` — visitor sessions.
- `product_views` — product detail page views.
- `add_to_carts`
- `checkouts` — checkouts started.
- `orders` — orders completed.
- `conversion_rate` — funnel completion. **Not** eligible for `WITH CUMULATIVE_VALUES`.
- `cart_abandonment_rate` — likewise not cumulative.

### Common dimensions

- `product_title`, `product_id`
- Time dimensions for trending.
- Geographic and channel dimensions where exposed.

The classic conversion query joins `sessions` with `sales` on `day` (see `recipes.md` → "Conversion funnel").

---

## Cross-table dimensions for implicit joins

When you query multiple tables in one `FROM`, the join is on **dimensions that exist in both tables and are present in `GROUP BY`**. The most reliable shared dimensions:

- Time dimensions (`day`, `week`, `month`, …).
- `product_id`, `product_title` — across `sales`, `products`, `sessions`.
- `customer_id`, `customer_email` — across `sales`, `orders`, `customers`.
- `shop_id`, `shop_name` — for multi-store rollups.

Example:

```shopifyql
FROM sales, sessions
  SHOW day, total_sales, sessions
  GROUP BY day
```

If you forget to include the shared dimension in `GROUP BY`, the join either fails or returns ambiguous results.

---

## Multi-store dimensions

When `FROM ORGANIZATION <table>` is used, two extra dimensions become available:

| Dimension | Notes |
| --- | --- |
| `shop_id` | Numeric ID for a specific store. Filter with `WHERE shop_id IN (…)`. |
| `shop_name` | Human-readable shop name. Use in `GROUP BY` for per-store rollups. |

Multi-store queries default to the current store's currency and timezone. Override with `WITH CURRENCY 'USD', TIMEZONE 'America/New_York'`.

---

## Metafields

Custom fields can be queried in `SHOW`, `WHERE`, and `GROUP BY` if their definition has `use_in_analytics` enabled.

### Owner types

`customer`, `order`, `product`, `product_variant`

### Reference syntax

```
<owner_type>.metafields.<namespace>.<key>
```

Example: `product.metafields.custom.category`, `customer.metafields.custom.membership_level`.

### Supported types

**Scalar:** `single_line_text_field`, `multi_line_text_field`, `number_integer`, `number_decimal`, `date`, `date_time`, `url`, `boolean`, `color`, `id`, `product_reference`, `rating`

**List:** `list.single_line_text_field`, `list.multi_line_text_field`, `list.number_integer`, `list.number_decimal`

### Examples

```shopifyql
FROM customers
  SHOW customer_name, total_amount_spent
  WHERE customer.metafields.custom.membership_level = 'gold'
  GROUP BY customer_name
```

```shopifyql
FROM sales
  SHOW total_sales
  GROUP BY product.metafields.custom.category
```

```shopifyql
FROM sales
  SHOW total_sales
  WHERE customer.metafields.custom.vip = true
    AND product.metafields.reviews.rating > 4
  GROUP BY product_title
```

---

## Semi-join expressions for `MATCHES`

These are most useful when filtering `customers` by behavior. Each parameter can be used **only once** per `MATCHES` filter — restructure with `count`/`sum_amount` if you need a range.

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

### Patterns

VIP buyers — at least 5 orders since Jan 1:

```shopifyql
FROM customers
  SHOW customer_email, total_amount_spent
  WHERE orders_placed MATCHES (date > '2025-01-01', count >= 5)
  ORDER BY total_amount_spent DESC
```

Engaged but lapsed — opened recent email, no orders in last 90 days:

```shopifyql
FROM customers
  SHOW customer_email
  WHERE shopify_email.opened MATCHES (date > '2025-08-01')
    AND orders_placed NOT MATCHES (date > '2025-08-01')
```

Customers within 25 km of a store:

```shopifyql
FROM customers
  SHOW customer_email
  WHERE customer_within_distance MATCHES (
    coordinates = '49.2827,-123.1207',
    distance_km = 25
  )
```
