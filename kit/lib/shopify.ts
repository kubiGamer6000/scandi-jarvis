/**
 * Shopify Admin API — the source of truth for revenue, orders and fulfilment.
 *
 * Two ways in, and the choice matters:
 *   shopifyQl()  — daily aggregates. Fast. Use for "how much did we sell".
 *   graphql()    — per-order and line-item detail. Use when you need records.
 *
 * Never use Triple Whale for revenue. It is an attribution tool and will not
 * match Shopify.
 */
import { HttpError, isRetryableStatus, linear, requestJson, sleep, withRetry } from './http.ts';
import { gateway } from './env.ts';

export interface ShopifyCost {
  actualQueryCost?: number;
  throttleStatus?: { currentlyAvailable?: number; restoreRate?: number };
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: ShopifyCost };
}

/**
 * Pause when the leaky bucket lacks the credits for the next page. Cheaper
 * than being throttled and having to back off after the fact.
 */
export async function respectThrottle(cost?: ShopifyCost): Promise<void> {
  const available = cost?.throttleStatus?.currentlyAvailable ?? 1000;
  const needed = cost?.actualQueryCost ?? 200;
  if (available >= needed) return;
  const restoreRate = cost?.throttleStatus?.restoreRate ?? 50;
  await sleep(Math.min(Math.ceil((needed - available) / restoreRate) * 1000, 5000));
}

let lastCost: ShopifyCost | undefined;
/** Bucket state from the most recent call, for pagination loops. */
export const lastQueryCost = (): ShopifyCost | undefined => lastCost;

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  // The Jarvis kit gateway does the OAuth token exchange and refuses mutations
  // (bulkOperationRunQuery excepted, since it only exports a query).
  const g = gateway('shopify');
  const url = `${g.url}/graphql`;

  return withRetry(
    async () => {
      const json = await requestJson<GraphqlResponse<T>>(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...g.headers,
        },
        body: JSON.stringify({ query, variables }),
      });

      lastCost = json.extensions?.cost;

      // THROTTLED arrives as a 200 with an error body, so it has to be caught
      // here rather than by the status-code predicate.
      if (json.errors?.some((err) => err.extensions?.code === 'THROTTLED')) {
        throw new HttpError(429, 'THROTTLED', url);
      }
      if (json.errors?.length) {
        throw new Error(json.errors.map((err) => err.message).join('; '));
      }
      if (!json.data) throw new Error('Shopify returned no data');
      return json.data;
    },
    {
      label: 'Shopify GraphQL',
      delayFor: linear(2000),
      shouldRetry: isRetryableStatus,
    },
  );
}

export interface ShopifyQlTable {
  columns: Array<{ name: string; dataType: string; displayName: string }>;
  /**
   * Every value arrives as a STRING regardless of dataType — cast before doing
   * arithmetic. Rows come back keyed by column name on API 2026-01, though
   * positional arrays appear in older docs, so `rowsToObjects` handles both.
   */
  rows: Array<Record<string, string>> | string[][];
}

/**
 * Run a ShopifyQL query. This is the intended tool for analytics questions —
 * reach for it before writing an order-pulling loop.
 *
 * `parseErrors` is the debugging trace: treat it like a compiler error and fix
 * the exact symbol it names. The `shopifyql` skill has the syntax reference.
 */
export async function shopifyQl(query: string): Promise<ShopifyQlTable> {
  const data = await graphql<{
    shopifyqlQuery: { parseErrors: unknown[] | null; tableData: ShopifyQlTable | null };
  }>(
    `query RunShopifyQl($q: String!) {
       shopifyqlQuery(query: $q) {
         parseErrors
         tableData { columns { name dataType displayName } rows }
       }
     }`,
    { q: query },
  );

  const result = data.shopifyqlQuery;
  if (result.parseErrors?.length) {
    throw new Error(`ShopifyQL parse error: ${JSON.stringify(result.parseErrors)}`);
  }
  return result.tableData ?? { columns: [], rows: [] };
}

/** dataTypes arrive uppercase (MONEY, INTEGER). Compared case-insensitively. */
const NUMERIC_TYPES = new Set(['float', 'integer', 'decimal', 'money', 'percent', 'number']);

/** ShopifyQL rows as plain objects, with numeric columns cast to numbers. */
export function rowsToObjects(table: ShopifyQlTable): Array<Record<string, string | number>> {
  return table.rows.map((row) => {
    const out: Record<string, string | number> = {};
    table.columns.forEach((col, index) => {
      const raw = Array.isArray(row) ? (row[index] ?? '') : (row[col.name] ?? '');
      out[col.name] = NUMERIC_TYPES.has(col.dataType.toLowerCase()) ? Number(raw) : raw;
    });
    return out;
  });
}

/**
 * Order tags are the only reliable way to identify subscription orders — there
 * is no product-level subscription flag. These are the tag sets the profit
 * pipeline uses, reproduced so a ShopifyQL query can filter the same way.
 */
export const ORDER_TAGS = {
  /** A rebill. Note "Subscription Order: 2" is the *second* charge, because
   *  `cyclesCompleted` counts the checkout as cycle 1. */
  recurring: ['Subscription Recurring Order', 'Subscription Order: 2', 'Subscription Order: 3'],
  firstOrder: ['Subscription First Order'],
} as const;

/** `WHERE` clause matching any of the given order tags. */
export function orderTagFilter(tags: readonly string[]): string {
  return `(${tags.map((t) => `order_tags CONTAINS '${t}'`).join(' OR ')})`;
}

/** Paginate an `orders` connection. Page size 100 is Shopify's practical max. */
export async function* paginateOrders<T>(
  nodeFields: string,
  search: string,
  pageSize = 100,
): AsyncGenerator<T> {
  let cursor: string | null = null;
  for (;;) {
    const data: {
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; edges: Array<{ node: T }> };
    } = await graphql(
      `query Orders($cursor: String, $pageSize: Int!, $search: String!) {
         orders(first: $pageSize, after: $cursor, query: $search,
                sortKey: CREATED_AT, reverse: true) {
           pageInfo { hasNextPage endCursor }
           edges { node { ${nodeFields} } }
         }
       }`,
      { cursor, pageSize, search },
    );

    for (const edge of data.orders.edges) yield edge.node;
    if (!data.orders.pageInfo.hasNextPage) return;
    cursor = data.orders.pageInfo.endCursor;
    await respectThrottle(lastCost);
  }
}
