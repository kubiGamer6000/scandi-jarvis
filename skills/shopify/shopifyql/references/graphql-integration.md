# Calling ShopifyQL via the Admin GraphQL API

How to wire a ShopifyQL query into the Shopify Admin API, what scopes you need, what the response looks like, and how to debug parse errors. Read this when you are writing code that calls Shopify (not just authoring queries for a human to paste into the admin UI).

## Table of contents

1. [The `shopifyqlQuery` endpoint](#the-shopifyqlquery-endpoint)
2. [Required access scopes](#required-access-scopes)
3. [Request shape](#request-shape)
4. [Response shape](#response-shape)
5. [Column data types](#column-data-types)
6. [Debugging `parseErrors`](#debugging-parseerrors)
7. [Rate limiting](#rate-limiting)
8. [Performance tips](#performance-tips)
9. [Multi-store and `FROM ORGANIZATION`](#multi-store-and-from-organization)
10. [Other surfaces](#other-surfaces)

---

## The `shopifyqlQuery` endpoint

ShopifyQL is exposed through a single GraphQL Admin API field:

```graphql
type QueryRoot {
  shopifyqlQuery(query: String!): ShopifyqlResponse
}
```

The full GraphQL Admin API reference for this field lives at <https://shopify.dev/docs/api/admin-graphql/latest/queries/shopifyqlquery>.

You send a ShopifyQL string in the `query` argument, and you get a structured `tableData` payload back along with any `parseErrors`.

---

## Required access scopes

Without the right scopes the API returns a permission error before it ever parses your query. Request all that apply:

| Scope | Purpose |
| --- | --- |
| `read_reports` | **Required for all ShopifyQL queries.** Access to analytics and reporting data. |
| `read_customers` | Required when querying or filtering on customer data. |
| `read_customer_address` | Required when reading customer address fields (`billing_country`, etc. through customer joins). |
| `read_customer_email` | Required when reading customer email addresses. |
| `read_customer_name` | Required when reading customer names. |
| `read_customer_phone` | Required when reading customer phone numbers. |

For pure sales/order/session reports without PII, `read_reports` alone is enough. The moment customer fields enter the query (`SHOW customer_email`, `WHERE customer.metafields.…`, `FROM customers`), add the relevant `read_customer_*` scopes.

---

## Request shape

A minimal request:

```graphql
query SalesLast7Days {
  shopifyqlQuery(
    query: "FROM sales SHOW total_sales SINCE -7d"
  ) {
    tableData {
      columns {
        name
        dataType
        displayName
      }
      rows
    }
    parseErrors {
      code
      message
    }
  }
}
```

For multi-line ShopifyQL, use a GraphQL block string (`"""…"""`) so the formatting survives:

```graphql
query SalesByVariantLast7Days {
  shopifyqlQuery(
    query: """
      FROM sales
        SHOW total_sales, variant_title, product_title
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

If your client sends the query as a JSON-quoted string, escape newlines (`\n`) — Shopify accepts a single-line query just as happily.

---

## Response shape

A successful response:

```json
{
  "data": {
    "shopifyqlQuery": {
      "tableData": {
        "columns": [
          {
            "name": "day",
            "dataType": "DAY_TIMESTAMP",
            "displayName": "Day"
          },
          {
            "name": "total_sales",
            "dataType": "MONEY",
            "displayName": "Total sales"
          }
        ],
        "rows": [
          { "day": "2024-01-15", "total_sales": "2547.83" },
          { "day": "2024-01-14", "total_sales": "1892.45" }
        ]
      },
      "parseErrors": []
    }
  }
}
```

Key points:

- `columns` — ordered, with `name` (column key in each row), `dataType`, and `displayName` (human label).
- `rows` — array of objects keyed by `column.name`. Order matches `columns`.
- `parseErrors` — empty on success; populated on parse failure (in which case `tableData` is empty or null).

A failure response:

```json
{
  "data": {
    "shopifyqlQuery": {
      "tableData": null,
      "parseErrors": [
        {
          "code": "INVALID_KEYWORD_ORDER",
          "message": "WHERE must precede GROUP BY"
        }
      ]
    }
  }
}
```

`parseErrors` is the structured error channel — read it before assuming a network problem.

---

## Column data types

Common values you will see in `column.dataType`. Useful for client-side formatting (currency, percent, date pickers) and unit tests.

| Data type | Notes |
| --- | --- |
| `MONEY` | Currency value as a stringified decimal. The currency is the store currency unless overridden by `WITH CURRENCY`. |
| `NUMBER` | Numeric value. |
| `PERCENT` | Percentage as a decimal (e.g. `0.123` = 12.3%). |
| `STRING` | Free-form text. |
| `DAY_TIMESTAMP` | `'YYYY-MM-DD'` for `day` grouping. |
| `WEEK_TIMESTAMP`, `MONTH_TIMESTAMP`, `QUARTER_TIMESTAMP`, `YEAR_TIMESTAMP` | Period start as a date string. |
| `HOUR_TIMESTAMP`, `MINUTE_TIMESTAMP`, `SECOND_TIMESTAMP` | Sub-day time. |
| `HOUR_OF_DAY`, `DAY_OF_WEEK`, `WEEK_OF_YEAR`, `MONTH_OF_YEAR` | Cyclical integer dimensions (zero- or one-based per the dimension). |

If the response uses a data type not in this list, treat it as a string for display and look it up in the Admin API reference.

---

## Debugging `parseErrors`

When a request comes back with non-empty `parseErrors`, treat them like compiler errors. Each one names a specific problem:

1. **Read the message literally.** It will name the keyword, column, or symbol it choked on.
2. **Check keyword order first.** The most common cause is clauses out of sequence (see SKILL.md → "Required keyword order"). The error often says something like `KEYWORD_X must come after KEYWORD_Y`.
3. **Check `WHERE` vs `HAVING`.** If the message mentions a metric in a `WHERE`-style position, move the predicate into `HAVING` (and add `GROUP BY` if missing).
4. **Check that every dimension in `SHOW` is in `GROUP BY`.** If a column is named as "ungrouped", that is the cause.
5. **Check string quoting.** Single quotes for values, double quotes only for spaced aliases. A double-quoted value will produce an unknown-identifier error.
6. **Check column existence.** If the error says a column is unknown, the column name is wrong. Try the most likely alternative name (`variant_title` ↔ `product_variant_title`; `customer_email` ↔ `email`) or look it up in the Shopify dev docs.
7. **Re-run.** Each retry is a separate billable query; make changes deliberately, not by trial and error spam.

A reasonable client-side loop:

```ts
async function runShopifyQL(query: string, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await callAdminAPI(SHOPIFYQL_QUERY_DOC, { query });
    const result = response.data.shopifyqlQuery;
    if (result.parseErrors?.length === 0) return result.tableData;
    console.warn(`ShopifyQL parseErrors:`, result.parseErrors);
    if (attempt === maxRetries) {
      throw new Error(
        `ShopifyQL failed after ${attempt + 1} attempts: ` +
        result.parseErrors.map(e => e.message).join("; ")
      );
    }
    query = await reviseQueryFromErrors(query, result.parseErrors);
  }
}
```

Notes:

- Do not retry on rate-limit errors (HTTP 429); back off instead — see below.
- Surface `parseErrors` to the human/agent that authored the query so they can fix it; do not silently retry indefinitely.

---

## Rate limiting

`shopifyqlQuery` has its own complexity-based rate limit, separate from the standard Admin API cost system. Complexity grows with:

- Number of metrics in `SHOW`.
- Number of dimensions in `GROUP BY`.
- Date range size.
- Use of `COMPARE TO`, `TIMESERIES`, and `WITH` modifiers.
- Number of tables in `FROM` (implicit joins).

When you exceed the limit you get an HTTP **429**. The limit resets on a **60-second** window — wait for the window to elapse before retrying.

Practical guidance:

- For dashboard refresh patterns, batch rendering so you do not fire all queries simultaneously.
- For long date ranges that would explode complexity, slice the range into smaller windows (e.g. one query per quarter) and stitch results client-side.
- When debugging, run lean queries first (smaller `SINCE`, fewer `GROUP BY` columns) and expand once correctness is confirmed.

---

## Performance tips

- **Narrow the date range.** Always set `SINCE`/`UNTIL` or `DURING` even for "all time" intents — there is no genuine "all time" use case that is not better expressed as a bounded window.
- **Filter early with `WHERE`.** `WHERE` runs before aggregation, so it shrinks the data set the rest of the query operates on.
- **Limit dimensions in `GROUP BY`.** Each additional dimension multiplies cardinality. Combine with `TOP N` to keep the result legible without dropping signal.
- **Use `LIMIT` for exploration.** Default is 1000; bring it down to 25–100 while iterating.
- **Prefer aggregates to raw rows.** ShopifyQL is built for analytics — if you find yourself trying to fetch raw transactional rows, consider whether `orders` or another OLTP-shaped Admin API resource is actually a better fit.
- **Cache stable results.** Reports for finished periods (e.g. last month) do not change; cache them.

---

## Multi-store and `FROM ORGANIZATION`

For organization-level queries (`FROM ORGANIZATION sales`), the request is the same but:

- The calling app must have access to the relevant organization-level scope.
- Currency and timezone default to the store currency/timezone of the requesting context. Use `WITH CURRENCY 'USD', TIMEZONE 'America/New_York'` to normalize for cross-store comparisons.
- `shop_id` and `shop_name` become first-class dimensions you can `WHERE`/`GROUP BY` on.

```graphql
query SalesByStore {
  shopifyqlQuery(
    query: """
      FROM ORGANIZATION sales
        SHOW total_sales
        WHERE shop_id IN (10002, 20023)
        GROUP BY shop_name
        DURING last_month
        WITH CURRENCY 'USD'
    """
  ) {
    tableData { columns { name dataType } rows }
    parseErrors { code message }
  }
}
```

---

## Other surfaces

The same ShopifyQL syntax also works in:

- **The Shopify admin's analytics editor**, with syntax highlighting and live visualization.
- **The Shopify Python SDK** (`shopifyql-py`), which returns results as `pandas.DataFrame` for analytics workflows. Useful when the goal is exploratory analysis rather than building a feature.
- **Shopify's segment editor**, but only the `WHERE` subset (the [segment query language](https://shopify.dev/docs/api/shopifyql/segment-query-language-reference)).

The query string is portable across these surfaces — develop and validate in the admin editor, then drop the same string into the GraphQL request.
