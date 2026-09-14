/**
 * Meta Marketing API — ad spend and platform-reported conversions.
 *
 * Two distinct uses, and mixing them up produces nonsense:
 *   level=account  — daily spend for the profit picture
 *   level=ad       — per-ad creative performance (hook variants, editors)
 *
 * Meta is NOT the source for revenue. Its action_values are pixel-attributed
 * and will not match Shopify. And never add Meta spend to Triple Whale spend —
 * that double-counts Facebook.
 */
import { env, gateway, metaAdAccountIds } from './env.ts';
import { HttpError, exponential, pacer, requestJson, withRetry } from './http.ts';

const base = () => `${gateway('meta').url}/${env().META_API_VERSION}`;

/**
 * `paging.next` links point at graph.facebook.com and carry no credentials
 * (auth is a header), so send them back through the gateway.
 */
const viaGateway = (next: string): string =>
  next.replace(/^https:\/\/graph\.facebook\.com\//, `${gateway('meta').url}/`);

/**
 * Attribution pinned explicitly rather than left to account defaults, so a
 * number pulled today is reproducible tomorrow. Always state this window when
 * quoting Meta conversions — it is why they don't match Shopify.
 */
export const ATTRIBUTION_WINDOWS = JSON.stringify(['7d_click', '1d_view']);

/**
 * Counts only, never rates.
 *
 * Meta will happily serve `inline_link_click_ctr` and friends, but a rate that
 * arrives per day cannot be re-aggregated into a range, and the "unique"
 * variants divide by reach, which is not additive at all. Store numerators,
 * divide at read time.
 */
export const INSIGHT_FIELDS_AD = [
  'ad_id',
  'ad_name',
  'impressions',
  'clicks',
  'inline_link_clicks',
  'spend',
  'actions',
  'action_values',
  'video_thruplay_watched_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p95_watched_actions',
  'video_p100_watched_actions',
].join(',');

export const INSIGHT_FIELDS_ACCOUNT = [
  'account_id',
  'impressions',
  'reach',
  'spend',
  'clicks',
  'inline_link_clicks',
  'actions',
  'action_values',
].join(',');

/**
 * A video ID can live in three places, so collect all of them when identifying
 * an asset. There is deliberately no /adcreatives or /advideos call anywhere —
 * creative identity comes entirely from this nested shape, and thumbnails come
 * from Google Drive, not Meta.
 */
export const AD_FIELDS = [
  'name',
  'created_time',
  'effective_status',
  'campaign_id',
  'adset_id',
  'campaign{name}',
  'adset{name}',
  'creative{id,name,object_type,video_id,' +
    'object_story_spec{video_data{video_id,title}},' +
    'asset_feed_spec{videos{video_id}}}',
].join(',');

/** 400ms between calls. See the note on error budgets in `get`. */
const pace = pacer(400);

/** Error codes worth retrying. Anything else is a real problem with the request. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 613, 80000, 80003, 80004]);

function throttleUtilisation(headers: Headers): number {
  // Meta reports utilisation two different ways depending on the edge.
  const insights = headers.get('x-fb-ads-insights-throttle');
  const business = headers.get('x-business-use-case-usage');
  let worst = 0;
  for (const raw of [insights, business]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const scan = (value: unknown): void => {
        if (typeof value === 'number') worst = Math.max(worst, value);
        else if (Array.isArray(value)) value.forEach(scan);
        else if (value && typeof value === 'object') Object.values(value).forEach(scan);
      };
      scan(parsed);
    } catch {
      /* header shape changes occasionally; pacing still applies */
    }
  }
  return worst;
}

export async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${base()}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  return withRetry(
    async () => {
      await pace();
      const res = await fetch(url, {
        headers: gateway('meta').headers,
        signal: AbortSignal.timeout(120_000),
      });

      // Meta's rate-limit budget SHRINKS when you generate errors, so a
      // misbehaving integration digs its own hole. Standing down above 80%
      // utilisation is cheaper than being locked out. Healthy runs sit at 2-8%.
      const utilisation = throttleUtilisation(res.headers);
      if (utilisation > 80) {
        console.warn(`  Meta throttle at ${utilisation}% — pausing 60s`);
        await new Promise((r) => setTimeout(r, 60_000));
      }

      const text = await res.text();
      if (!res.ok) {
        const parsed = JSON.parse(text || '{}') as { error?: { code?: number; message?: string } };
        const code = parsed.error?.code;
        const error = new HttpError(res.status, parsed.error?.message ?? text, url.pathname);
        // Only retry the transient codes; a bad field name will never succeed.
        if (code !== undefined && !RETRYABLE_CODES.has(code)) {
          throw Object.assign(error, { permanent: true });
        }
        throw error;
      }
      return JSON.parse(text) as T;
    },
    {
      label: `Meta ${path}`,
      delayFor: exponential(30_000),
      shouldRetry: (error) => !(error as { permanent?: boolean }).permanent,
    },
  );
}

/** Follow `paging.next` to the end of a cursor-paginated edge. */
export async function getAll<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  let page = await get<{ data: T[]; paging?: { next?: string } }>(path, params);
  out.push(...(page.data ?? []));

  while (page.paging?.next) {
    await pace();
    const res = await fetch(viaGateway(page.paging.next), {
      headers: gateway('meta').headers,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) break;
    page = (await res.json()) as { data: T[]; paging?: { next?: string } };
    out.push(...(page.data ?? []));
  }
  return out;
}

export interface ActionEntry {
  action_type: string;
  value: string;
  [key: string]: string;
}

export interface AdInsightRow {
  ad_id: string;
  ad_name?: string;
  date_start: string;
  date_stop: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  spend?: string;
  actions?: ActionEntry[];
  action_values?: ActionEntry[];
  video_thruplay_watched_actions?: ActionEntry[];
  video_p25_watched_actions?: ActionEntry[];
  video_p50_watched_actions?: ActionEntry[];
  video_p75_watched_actions?: ActionEntry[];
  video_p95_watched_actions?: ActionEntry[];
  video_p100_watched_actions?: ActionEntry[];
}

/**
 * One row per ad per day.
 *
 * The server-side `ad.impressions > 0` filter means undelivered ads never
 * travel, which is a meaningful saving on accounts with a long tail.
 */
export async function adInsights(
  accountId: string,
  since: string,
  until: string,
): Promise<AdInsightRow[]> {
  return getAll<AdInsightRow>(`${accountId}/insights`, {
    level: 'ad',
    fields: INSIGHT_FIELDS_AD,
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    action_attribution_windows: ATTRIBUTION_WINDOWS,
    filtering: JSON.stringify([
      { field: 'ad.impressions', operator: 'GREATER_THAN', value: 0 },
    ]),
    limit: '500',
  });
}

/** Daily account-level rows across every configured account. */
export async function accountInsights(
  since: string,
  until: string,
  accountIds = metaAdAccountIds(),
): Promise<Array<AdInsightRow & { account_id: string }>> {
  const out: Array<AdInsightRow & { account_id: string }> = [];
  for (const accountId of accountIds) {
    const rows = await getAll<AdInsightRow & { account_id: string }>(`${accountId}/insights`, {
      level: 'account',
      fields: INSIGHT_FIELDS_ACCOUNT,
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
      action_attribution_windows: ATTRIBUTION_WINDOWS,
      limit: '500',
    });
    out.push(...rows);
  }
  return out;
}

export interface AdCreative {
  id?: string;
  name?: string;
  object_type?: string;
  video_id?: string;
  object_story_spec?: { video_data?: { video_id?: string; title?: string } };
  asset_feed_spec?: { videos?: Array<{ video_id?: string }> };
}

export interface AdRecord {
  id: string;
  name?: string;
  created_time?: string;
  effective_status?: string;
  campaign_id?: string;
  adset_id?: string;
  campaign?: { name?: string };
  adset?: { name?: string };
  creative?: AdCreative;
}

/**
 * Fetch ads by ID, 50 per call — that is the documented batch ceiling for the
 * `?ids=` form.
 */
export async function adsByIds(adIds: string[]): Promise<Map<string, AdRecord>> {
  const found = new Map<string, AdRecord>();
  for (let i = 0; i < adIds.length; i += 50) {
    const batch = adIds.slice(i, i + 50);
    const page = await get<Record<string, AdRecord>>('', {
      ids: batch.join(','),
      fields: AD_FIELDS,
    });
    for (const [id, record] of Object.entries(page)) found.set(id, { ...record, id });
  }
  return found;
}

/** Every video ID Meta exposes for a creative, from all three locations. */
export function videoIdsOf(creative?: AdCreative): string[] {
  return [
    creative?.video_id,
    creative?.object_story_spec?.video_data?.video_id,
    ...(creative?.asset_feed_spec?.videos ?? []).map((v) => v.video_id),
  ].filter((v): v is string => Boolean(v));
}

export const isVideoCreative = (creative?: AdCreative): boolean =>
  creative?.object_type === 'VIDEO' || videoIdsOf(creative).length > 0;

/**
 * Stable key for a video asset: the first Meta video ID, else a name-derived
 * fallback. The fallback keeps ads addressable when Meta exposes no asset.
 */
export function videoKeyOf(ad: AdRecord): string | null {
  const [first] = videoIdsOf(ad.creative);
  if (first) return first;
  const name = ad.creative?.name ?? ad.name;
  return name ? `name:${name.toUpperCase()}` : null;
}

/** Sum one action type out of an `actions` / `action_values` array. */
export function actionValue(entries: ActionEntry[] | undefined, actionType: string): number {
  if (!entries) return 0;
  return entries
    .filter((entry) => entry.action_type === actionType)
    .reduce((sum, entry) => sum + Number(entry.value || 0), 0);
}

/**
 * Revenue and purchase count, from `omni_purchase` ONLY.
 *
 * The arrays hold several aliases of the same conversion — `omni_purchase`,
 * `purchase`, `offsite_conversion.fb_pixel_purchase`. Summing them multiplies
 * revenue several times over. `omni_purchase` is Meta's unified event and the
 * one behind Ads Manager's purchase_roas, so figures built on it reconcile
 * with the dashboard.
 */
export function purchases(row: AdInsightRow): { count: number; valueNative: number } {
  return {
    count: actionValue(row.actions, 'omni_purchase'),
    valueNative: actionValue(row.action_values, 'omni_purchase'),
  };
}

/**
 * 3-second plays. There is no dedicated field — it is the `video_view` action
 * type inside `actions`.
 */
export const threeSecondPlays = (row: AdInsightRow): number =>
  actionValue(row.actions, 'video_view');

/**
 * The `video_p*` fields come back as single-entry arrays keyed by an action
 * type that carries no extra meaning, so the first entry is the total.
 */
const firstEntry = (entries?: ActionEntry[]): number => Number(entries?.[0]?.value ?? 0);

/**
 * Meta reports exactly six moments in a play. There is no 10% or 90% field —
 * if someone asks for those, say so rather than interpolating.
 */
export function videoRetention(row: AdInsightRow): {
  plays3s: number;
  thruplays: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p100: number;
} {
  return {
    plays3s: threeSecondPlays(row),
    thruplays: firstEntry(row.video_thruplay_watched_actions),
    p25: firstEntry(row.video_p25_watched_actions),
    p50: firstEntry(row.video_p50_watched_actions),
    p75: firstEntry(row.video_p75_watched_actions),
    p95: firstEntry(row.video_p95_watched_actions),
    p100: firstEntry(row.video_p100_watched_actions),
  };
}
