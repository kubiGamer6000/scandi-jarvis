/**
 * Currency conversion to EUR.
 *
 * The store reports in EUR but Meta ad accounts report in their own native
 * currency, so per-day conversion is needed before spend can be compared or
 * summed.
 *
 * The Profit API's own `fx_rates` table is the reproducible source for
 * historical conversions — this module is for ad-hoc work where hitting the
 * public rate services is good enough. If a figure is going into a report that
 * will be compared against the dashboard, use the dashboard's numbers instead.
 */
import { cached } from './cache.ts';
import { requestJson, withRetry } from './http.ts';

export interface RateTable {
  base: string;
  date: string;
  rates: Record<string, number>;
}

/**
 * Rates for a date, EUR base. Pass 'latest' for today.
 *
 * Two providers, because Frankfurter has no weekend rows and occasionally
 * 404s on a bank holiday; open.er-api.com covers the gap.
 */
async function fetchRates(date: string): Promise<RateTable> {
  try {
    return await withRetry(
      () => requestJson<RateTable>(`https://api.frankfurter.app/${date}?from=EUR`),
      { label: 'Frankfurter FX', attempts: 3 },
    );
  } catch {
    const fallback = await requestJson<{ rates: Record<string, number>; time_last_update_utc: string }>(
      'https://open.er-api.com/v6/latest/EUR',
    );
    return { base: 'EUR', date, rates: fallback.rates };
  }
}

/**
 * Rates cached for a day. Historical rates never change, so this is safe;
 * 'latest' is refreshed every 12 hours.
 */
export async function ratesOn(date = 'latest'): Promise<RateTable> {
  const maxAge = date === 'latest' ? 12 * 3_600_000 : 365 * 24 * 3_600_000;
  return cached(`fx/${date}`, maxAge, () => fetchRates(date));
}

/**
 * Convert to EUR. Note the division: the table is EUR-based, so `rates.USD` is
 * how many dollars one euro buys, and dollars are divided by it.
 */
export async function toEur(
  amount: number,
  currency: string,
  date = 'latest',
): Promise<number> {
  const code = currency.toUpperCase();
  if (code === 'EUR') return amount;
  const table = await ratesOn(date);
  const rate = table.rates[code];
  if (!rate) throw new Error(`No EUR rate for ${code} on ${date}`);
  return amount / rate;
}

/** Sign goes outside the symbol: -€4,150, not €-4,150. */
export const formatEur = (amount: number, decimals = 0): string => {
  const body = Math.abs(amount).toLocaleString('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${amount < 0 ? '-' : ''}€${body}`;
};
