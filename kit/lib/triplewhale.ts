/**
 * Triple Whale — blended ad spend.
 *
 * Currently the ONLY source for Google and TikTok spend. For Facebook it is
 * the last resort, behind the sheet and the Meta API.
 *
 * It is an attribution tool: its revenue and ROAS use its own pixel model and
 * will not match Shopify. Use Shopify for revenue, Triple Whale for spend.
 */
import { env, gateway } from './env.ts';
import { exponential, isRetryableStatus, requestJson, withRetry } from './http.ts';


/**
 * Metric IDs, keyed by what we call them. The response is keyed by metric ID.
 */
export const METRIC_IDS = {
  googleSpend: 'googleAds',
  tiktokSpend: 'tiktokAds',
  facebookSpend: 'facebookAds',
  pixelVisitSessions: 'pixelVisitSessions',
  tiktokImpressions: 'tiktokImpressions',
} as const;

export interface SummaryMetric {
  id: string;
  title?: string;
  metricId?: string;
  value?: number;
  [key: string]: unknown;
}

/**
 * Summary page data for a date range.
 *
 * Three parameter-naming traps live in this one request, all found by trial
 * and error rather than from the docs:
 *   - `shopDomain`, not `shop`
 *   - `period`, not `startDate`/`endDate`
 *   - `todayHour` is 1-INDEXED
 */
export async function summaryPage(since: string, until: string): Promise<SummaryMetric[]> {
  const e = env();
  const g = gateway('triplewhale');
  const json = await withRetry(
    () =>
      requestJson<{ metrics?: SummaryMetric[] }>(
        `${g.url}/summary-page/get-data`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...g.headers },
          body: JSON.stringify({
            shopDomain: e.SHOPIFY_STORE_DOMAIN,
            period: { start: since, end: until },
            todayHour: new Date().getHours() + 1,
          }),
        },
        120_000,
      ),
    { label: 'Triple Whale', attempts: 4, delayFor: exponential(20_000), shouldRetry: isRetryableStatus },
  );
  return json.metrics ?? [];
}

/** Pull the spend metrics we actually use out of a summary response. */
export function spendByPlatform(metrics: SummaryMetric[]): {
  google: number | null;
  tiktok: number | null;
  facebook: number | null;
} {
  const find = (id: string): number | null => {
    const metric = metrics.find((m) => m.id === id || m.metricId === id);
    return typeof metric?.value === 'number' ? metric.value : null;
  };
  return {
    google: find(METRIC_IDS.googleSpend),
    tiktok: find(METRIC_IDS.tiktokSpend),
    facebook: find(METRIC_IDS.facebookSpend),
  };
}
