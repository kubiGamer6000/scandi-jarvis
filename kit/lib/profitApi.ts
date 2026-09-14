/**
 * The Scandi Profit API — our own dashboard, served by the Ultimate Scandi App.
 *
 * Prefer this over recomputing from Shopify/Meta/Skio. It already resolves
 * ad-spend precedence, effective-dated rates, COGS fallback, the Skio charge
 * model and the risk haircut. Going around it is how those rules get silently
 * dropped.
 *
 * It only stores DAILY AGGREGATES though. The moment a question needs a single
 * order, a single ad or a single subscriber, go to the source API instead.
 *
 * Calls go through the Jarvis kit gateway, which holds the key. The key is
 * read-only and enforced structurally: it can only issue GETs.
 */
import { DEFAULT_STORE_ID, gateway } from './env.ts';
import { exponential, isRetryableStatus, requestJson, withRetry } from './http.ts';

export interface DateRange {
  from?: string;
  to?: string;
  /** Window length. Used only when `from` is omitted; counts back from `to`. */
  days?: number;
  store?: string;
}

/** Day boundaries are Europe/Stockholm, not UTC. */
function query(range: DateRange = {}): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  if (range.days !== undefined && !range.from) params.set('days', String(range.days));
  params.set('store', range.store ?? DEFAULT_STORE_ID);
  return params.toString();
}

export async function apiGet<T>(path: string, range?: DateRange): Promise<T> {
  // Through the Jarvis kit gateway, which adds the read-only key.
  const g = gateway('profit');
  const suffix = range ? `?${query(range)}` : '';
  return withRetry(
    () =>
      requestJson<T>(`${g.url}${path}${suffix}`, {
        headers: g.headers,
      }),
    { label: `Profit API ${path}`, delayFor: exponential(10_000), shouldRetry: isRetryableStatus },
  );
}

// --------------------------------------------------------------------- types

export interface ProfitBlock {
  revenueEur: number;
  adSpendEur: number;
  cogs: {
    amountEur: number;
    pctOfRevenue: number;
    /** actual | estimated | mixed | none */
    source: string;
    estimatePct: number;
    daysActual: number;
    daysEstimated: number;
    /** "26% of this window is assumed, not measured." Quote this. */
    estimatedShareOfRevenue: number;
  };
  gatewayFeesEur: number;
  gatewayRatePct: number;
  profit: {
    trueProfitEur: number;
    marginPct: number;
    isEstimated: boolean;
    estimatedComponents: string[];
  };
  /** Uses the 40% COGS estimate and omits gateway fees. A different question. */
  profitExcludingSubsEur: number;
}

export interface PlatformAds {
  spendEur: number;
  impressions?: number;
  clicks?: number;
  linkClicks?: number;
  landingPageViews?: number;
  addToCart?: number;
  initiateCheckout?: number;
  purchases?: number;
  purchaseValueEur: number;
  /** Platform-attributed, so it will not match Shopify. Blended ROAS is the honest one. */
  roas: number;
  cpa?: number;
  cpm?: number;
}

export interface Summary {
  range: { storeId: string; from: string; to: string };
  revenue: {
    totalEur: number;
    recurringEur: number;
    nonRecurringEur: number;
    newSubEur: number;
    refundsEur: number;
  };
  orders: {
    total: number;
    recurring: number;
    reshipped: number;
    newSubs: number;
    aovEur: number;
    aovNonSubEur: number;
    subShareOfOrders: number;
  };
  /** New vs returning. `roas` here is revenue from new customers over total spend. */
  newCustomers: {
    orders: number;
    revenueEur: number;
    returningOrders: number;
    returningRevenueEur: number;
    aovEur: number;
    shareOfOrders: number;
    roas: number;
  };
  traffic: { sessions: number; conversionRate: number; sessionSource: string };
  ads: {
    totalSpendEur: number;
    /** Total revenue over total spend. The figure to quote. */
    blendedRoas: number;
    meta: PlatformAds;
    google: PlatformAds;
    tiktok: PlatformAds;
  };
  subscriptions: {
    activeSubs: number;
    subsInDunning: number;
    activeSubsPaying: number;
    churn30: number;
    cancelledSubs: number;
    voluntaryCancels: number;
    dunningCancels: number;
    failedPayments: number;
  };
  profit: ProfitBlock;
  dataQuality: { daysMissingCogs: string[]; profitIsEstimated: boolean };
}

/**
 * The four MRR framings.
 *
 * All four are correct; they answer different questions. Lead with the
 * ceiling — it is the dashboard headline and the sheet's `Total MRR (Skio)`,
 * so it is what the team pictures when they say "MRR" — then report calendar
 * beside it and offer the difference. Never give a bare figure.
 */
export interface RevenueSnapshot {
  storeId: string;
  snapshotDate: string;
  horizonDays: number;
  /** Every charge scheduled in the next 30 days, if all collect. The house number. */
  ceilingTotal: number;
  ceilingProduct: number;
  ceilingShipping: number;
  ceilingCharges: number;
  /** Ceiling minus the risk haircut. What we expect to actually collect. */
  realisticTotal: number;
  realisticCharges: number;
  /** Derived, not configured. Read it; don't hardcode 21.3%. */
  haircutPct: number;
  lostToCancel: number;
  lostToFailure: number;
  subsBilling: number;
  /** The 28-day interval against a 30-day window means some subs bill twice. */
  subsBillingMoreThanOnce: number;
  subsNotBilling: number;
  pausedSubs: number;
  pausedAmountExcluded: number;
  /** Same book normalised to a real calendar month. THE growth figure. */
  mrrCalendar: number;
  /** Skio's own convention. Reconciliation only; understates a month by ~8.5%. */
  mrrFourWeek: number;
  activeSubs: number;
  avgChargeEur: number;
  isReconstructed: boolean;
  /** MRR is a nightly derive, not live. This says when it was computed. */
  snapshotAt: string;
}

export interface MrrMovement {
  storeId: string;
  date: string;
  horizonDays: number;
  ceilingStart: number;
  ceilingEnd: number;
  netChange: number;
  gainedNew: number;
  recoveredDunning: number;
  lostCancelled: number;
  lostDunning: number;
  /**
   * Window roll, rebills advancing, pauses, price edits. NOT noise — for a
   * 4-week billing book a one-day window roll is a real, recurring effect, and
   * it was 60% of one day's move. Never report netChange as churn.
   */
  residual: number;
  netFromCohorts: number;
  newSubs: number;
  cancelledSubs: number;
  enteredDunningSubs: number;
  recoveredDunningSubs: number;
  computedAt: string;
}

export interface Subscriptions {
  totals: Record<string, number>;
  revenue: RevenueSnapshot;
  history: Array<{ date: string; ceilingTotal: number; realisticTotal: number }>;
  movements: MrrMovement[];
  projectedProfit: { marginPct: number; onRealisticEur: number; onCeilingEur: number };
  risk: Record<string, unknown>;
  failedPayments: { byDay: Record<string, number>; observableFrom: string };
}

// ------------------------------------------------------------------- routes

/** Headline revenue, orders, ads, subs and the full profit breakdown. */
export const summary = (range: DateRange = { days: 7 }) => apiGet<Summary>('/summary', range);

/** Per-day series with profitEur, marginPct and profitIsEstimated. */
export const daily = (range: DateRange = { days: 30 }) =>
  apiGet<{ days: Array<Record<string, unknown>> }>('/daily', range);

/** The MRR endpoint: all four framings, history, movement bridge, risk. */
export const subscriptions = (range: DateRange = { days: 7 }) =>
  apiGet<Subscriptions>('/subscriptions', range);

/** Blended spend, per platform and per account, plus unresolved Triple Whale. */
export const ads = (range: DateRange = { days: 7 }) =>
  apiGet<Record<string, unknown>>('/ads', range);

export const dunning = (range: DateRange = { days: 30 }) =>
  apiGet<Record<string, unknown>>('/dunning', range);

export const cancellations = (range: DateRange = { days: 30 }) =>
  apiGet<Record<string, unknown>>('/cancellations', range);

/** Forecast scored against actuals, with MAPE. Judge trust before quoting. */
export const forecast = (range: DateRange = { days: 30 }) =>
  apiGet<Record<string, unknown>>('/forecast', range);

/** Hand-entered COGS, and which days are still missing it. */
export const manual = (range: DateRange = { days: 30 }) =>
  apiGet<Record<string, unknown>>('/manual', range);

/** Effective-dated rates: gateway %, COGS estimate %, subscription margin. */
export const settings = () => apiGet<Record<string, unknown>>('/settings');

/**
 * Pipeline health. Check this BEFORE trusting a number that looks odd — the
 * API serves stale data if the worker is down.
 */
export const syncStatus = () => apiGet<Record<string, unknown>>('/sync/status');

/** The authoritative endpoint list, straight from the deployment. */
export const openapi = () => apiGet<Record<string, unknown>>('/openapi.json');

// ------------------------------------------------------------------ helpers

/**
 * One line describing how much of a profit figure is measured versus assumed.
 * Quote this next to any margin — a 30.7% margin where a quarter of the cost
 * base is a flat 40% guess is a different claim from a measured one.
 */
export function cogsQualityNote(profit: ProfitBlock): string {
  const { cogs } = profit;
  if (!profit.profit.isEstimated) {
    return `COGS fully measured across all ${cogs.daysActual} days.`;
  }
  const share = (cogs.estimatedShareOfRevenue * 100).toFixed(1);
  return (
    `COGS is ${cogs.source}: ${cogs.daysActual} day(s) measured, ` +
    `${cogs.daysEstimated} estimated at ${(cogs.estimatePct * 100).toFixed(0)}%. ` +
    `${share}% of revenue in this window carries an assumed cost, so the margin is an estimate.`
  );
}

/**
 * The four framings, phrased the way they should be reported: ceiling first,
 * calendar beside it, and an offer to explain the gap.
 */
export function describeMrr(revenue: RevenueSnapshot): string {
  const eur = (n: number) => `€${Math.round(n).toLocaleString('en-GB')}`;
  return [
    `30-day ceiling ${eur(revenue.ceilingTotal)} — everything scheduled to bill in the next 30 days.`,
    `Calendar MRR ${eur(revenue.mrrCalendar)} — the same book normalised to a real calendar month, and the better figure for growth comparisons.`,
    `Realistic ${eur(revenue.realisticTotal)} after a ${(revenue.haircutPct * 100).toFixed(1)}% risk haircut — what we expect to actually collect.`,
    `Across ${revenue.activeSubs.toLocaleString('en-GB')} active subscriptions. Computed ${revenue.snapshotAt}.`,
  ].join('\n');
}

/**
 * Decompose a day's ceiling move. Guards against the most common MRR mistake:
 * reading the ceiling's day-over-day change as growth, when a rolling 30-day
 * window over 28-day billing cycles oscillates on its own.
 */
export function explainMovement(movement: MrrMovement): string {
  const eur = (n: number) => `${n < 0 ? '-' : '+'}€${Math.abs(Math.round(n)).toLocaleString('en-GB')}`;
  const lines = [
    `${movement.date}: ceiling moved ${eur(movement.netChange)}.`,
    `  new ${eur(movement.gainedNew)}, recovered ${eur(movement.recoveredDunning)}, ` +
      `cancelled ${eur(-movement.lostCancelled)}, dunning ${eur(-movement.lostDunning)}`,
    `  real cohort events: ${eur(movement.netFromCohorts)}`,
    `  residual (window roll, rebills advancing, pauses, price edits): ${eur(movement.residual)}`,
  ];

  // Compare the residual against the gross flows rather than against
  // netChange. On a day where the ceiling barely moves, netChange is a small
  // difference of large numbers and the ratio to it explodes past 100% —
  // technically true, but it reads like an error.
  const gross =
    movement.gainedNew +
    movement.recoveredDunning +
    movement.lostCancelled +
    movement.lostDunning;
  const netIsNoise = gross > 0 && Math.abs(movement.netChange) < gross * 0.05;

  if (netIsNoise) {
    lines.push(
      `  The ceiling was essentially flat: ${eur(gross)} of gross movement nearly cancelled out. ` +
        `Don't read a trend into this day.`,
    );
  } else if (Math.abs(movement.residual) > Math.abs(movement.netChange) * 0.3) {
    const share = Math.abs(movement.residual / movement.netChange);
    lines.push(
      `  Note: the residual is ${(Math.min(share, 1) * 100).toFixed(0)}% of the move, so most of ` +
        `this is not growth or churn. Quote calendar MRR for growth instead.`,
    );
  }
  return lines.join('\n');
}
