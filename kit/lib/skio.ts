/**
 * Skio — subscriptions. Hasura GraphQL, so offset pagination.
 *
 * THE ONE THING TO KNOW: very few columns are indexed. Filtering on a business
 * date column like `subscriptionBillingDate` takes over seven minutes and then
 * times out; the same filter on `createdAt` or `updatedAt` returns in five
 * seconds. Pull on a watermark, then do the analysis locally.
 *
 * Introspection is enabled — introspect before guessing field names. The
 * original field set here was assembled by guessing and reading errors, which
 * is how `BillingAttempts`, `AuditLog` and the cancel-flow tables went
 * unnoticed for months.
 */
import { exponential, isRetryableStatus, requestJson, withRetry } from './http.ts';
import { gateway } from './env.ts';


export async function skioGql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  return withRetry(
    async () => {
      const json = await requestJson<{
        data?: T;
        errors?: Array<{ message: string }>;
      }>(
        `${gateway('skio').url}/graphql`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // The gateway adds Skio's `authorization: API <key>` header.
            ...gateway('skio').headers,
          },
          body: JSON.stringify({ query, variables }),
        },
        90_000,
      );
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
      if (!json.data) throw new Error('Skio returned no data');
      return json.data;
    },
    {
      label: 'Skio GraphQL',
      // Exponential rather than linear: a DNS resolver that just failed is
      // usually still failing a second later, and these pulls run for minutes
      // anyway, so waiting half a minute to save a seven-minute walk is cheap.
      delayFor: exponential(30_000),
      shouldRetry: isRetryableStatus,
    },
  );
}

/**
 * Walk every page of a Hasura root field. Page size 500-1000.
 *
 * `query` must accept `$limit` and `$offset` and must have a stable
 * `order_by`, or offset pagination will skip and duplicate rows.
 */
export async function paginate<T>(
  query: string,
  rootField: string,
  variables: Record<string, unknown> = {},
  pageSize = 500,
  onPage?: (total: number) => void,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const data = await skioGql<Record<string, T[]>>(query, {
      ...variables,
      limit: pageSize,
      offset,
    });
    const batch = data[rootField] ?? [];
    out.push(...batch);
    onPage?.(out.length);
    if (batch.length < pageSize) return out;
  }
}

/** Fields that identify a subscription without pulling pricing detail. */
export const LIGHT_SUBSCRIPTION_FIELDS = `
  id status statusContext createdAt cancelledAt updatedAt
  nextBillingDate cyclesCompleted currencyCode
  BillingPolicy { interval intervalCount }
  StorefrontUser { email }
`;

/**
 * Everything the charge model needs. Only pull this when you actually need
 * money figures — it is far heavier than the light field set.
 */
export const PRICED_SUBSCRIPTION_FIELDS = `
  ${LIGHT_SUBSCRIPTION_FIELDS}
  deliveryPrice
  deliveryPriceOverride
  Discounts { type percentage title }
  SubscriptionLines {
    quantity priceWithoutDiscount isPrepaid
    Discounts { type percentage title }
    ProductVariant { title Product { title } }
  }
`;

export interface LightSubscription {
  id: string;
  status: string;
  statusContext: string | null;
  createdAt: string;
  cancelledAt: string | null;
  updatedAt: string;
  nextBillingDate: string | null;
  cyclesCompleted: number | null;
  currencyCode: string;
  BillingPolicy?: { interval?: string; intervalCount?: number } | null;
  StorefrontUser?: { email?: string } | null;
}

/** Active subscriptions, light fields. ~11,600 rows, a few minutes. */
export async function activeSubscriptions(
  onPage?: (total: number) => void,
): Promise<LightSubscription[]> {
  return paginate<LightSubscription>(
    `query ActiveSubs($limit: Int!, $offset: Int!) {
       Subscriptions(
         where: { status: { _eq: "ACTIVE" } }
         order_by: { updatedAt: asc }
         limit: $limit offset: $offset
       ) { ${LIGHT_SUBSCRIPTION_FIELDS} }
     }`,
    'Subscriptions',
    {},
    500,
    onPage,
  );
}

/**
 * Subscriptions changed since a watermark. Rewind the watermark ~10 minutes
 * from the last run so the overlap covers in-flight writes.
 */
export async function subscriptionsUpdatedSince(
  since: string,
  onPage?: (total: number) => void,
): Promise<LightSubscription[]> {
  return paginate<LightSubscription>(
    `query LightSince($limit: Int!, $offset: Int!, $since: timestamptz!) {
       Subscriptions(
         where: { updatedAt: { _gt: $since } }
         order_by: { updatedAt: asc }
         limit: $limit offset: $offset
       ) { ${LIGHT_SUBSCRIPTION_FIELDS} }
     }`,
    'Subscriptions',
    { since },
    500,
    onPage,
  );
}

/** True when a subscription has never rebilled. The checkout counts as cycle 1. */
export const neverRebilled = (sub: LightSubscription): boolean =>
  (sub.cyclesCompleted ?? 1) <= 1;

/** Voluntary cancel: CANCELLED with no statusContext. Dunning is involuntary. */
export const isVoluntaryCancel = (sub: LightSubscription): boolean =>
  sub.status === 'CANCELLED' && !sub.statusContext;

export const isDunning = (sub: LightSubscription): boolean => sub.statusContext === 'DUNNING';
export const isPaused = (sub: LightSubscription): boolean =>
  sub.statusContext === 'TEMPORARILY_PAUSED';

/** Billing interval in days. `WEEK` x4 = 28 days, which is ~89.6% of the base. */
export function intervalDays(sub: LightSubscription): number {
  const interval = sub.BillingPolicy?.interval?.toUpperCase();
  const count = sub.BillingPolicy?.intervalCount ?? 4;
  if (interval === 'WEEK') return count * 7;
  if (interval === 'MONTH') return count * 30;
  if (interval === 'DAY') return count;
  return 28;
}
