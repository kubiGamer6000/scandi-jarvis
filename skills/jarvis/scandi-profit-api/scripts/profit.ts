/**
 * Profit API command line.
 *
 * Formats the responses the way the numbers should be reported — margin next
 * to its COGS quality, MRR with both framings, movement decomposed — so the
 * caveats travel with the figures instead of being remembered separately.
 *
 *   tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts summary --days 7
 *   tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts mrr
 *   tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts daily --days 30
 *   tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts ads --from 2026-08-01 --to 2026-08-31
 *   tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts health
 *   tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts raw /api/cancellations --days 30
 */
import {
  type DateRange,
  ads,
  apiGet,
  cogsQualityNote,
  daily,
  describeMrr,
  explainMovement,
  subscriptions,
  summary,
  syncStatus,
} from '/home/app/kit/lib/profitApi.ts';
import { formatEur } from '/home/app/kit/lib/fx.ts';
import { parseArgs } from '/home/app/kit/lib/args.ts';

const { command, rest, flag, has } = parseArgs({ value: ['path'] });




const range: DateRange = {
  from: flag('from'),
  to: flag('to'),
  days: flag('days') ? Number(flag('days')) : undefined,
};
if (!range.from && !range.days) range.days = 7;

const pct = (value: number, decimals = 1) => `${(value * 100).toFixed(decimals)}%`;
const heading = (text: string) => console.log(`\n${text}\n${'='.repeat(text.length)}`);

function dump(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

switch (command) {
  case 'summary': {
    const data = await summary(range);
    if (has('json')) { dump(data); break; }

    heading(`${data.range.from} to ${data.range.to}`);
    console.log(`Revenue          ${formatEur(data.revenue.totalEur)}`);
    console.log(
      `  recurring      ${formatEur(data.revenue.recurringEur)}  (${pct(data.revenue.recurringEur / data.revenue.totalEur)} of revenue)`,
    );
    console.log(`  new subs       ${formatEur(data.revenue.newSubEur)}`);
    console.log(`  refunds        ${formatEur(data.revenue.refundsEur)}`);
    console.log(`Orders           ${data.orders.total.toLocaleString('en-GB')}  (AOV ${formatEur(data.orders.aovEur, 2)})`);
    console.log(`Ad spend         ${formatEur(data.ads.totalSpendEur)}  (blended ROAS ${data.ads.blendedRoas.toFixed(2)}x)`);
    console.log(
      `  meta ${formatEur(data.ads.meta.spendEur)} · tiktok ${formatEur(data.ads.tiktok.spendEur)} · google ${formatEur(data.ads.google.spendEur)}`,
    );

    const p = data.profit;
    console.log(`\nProfit           ${formatEur(p.profit.trueProfitEur)}   margin ${pct(p.profit.marginPct)}`);
    console.log(`  = revenue ${formatEur(p.revenueEur)} - ads ${formatEur(p.adSpendEur)} - cogs ${formatEur(p.cogs.amountEur)} - fees ${formatEur(p.gatewayFeesEur)}`);
    console.log(`\n  ${cogsQualityNote(p)}`);

    if (p.profitExcludingSubsEur < 0) {
      console.log(
        `\n  NOTE: profit excluding subscriptions is ${formatEur(p.profitExcludingSubsEur)} — NEGATIVE.\n` +
          `  New-customer acquisition ran at a loss in this window and subscriptions carried it.\n` +
          `  This is usually the real answer to "how are we doing?".`,
      );
    }
    if (data.dataQuality.daysMissingCogs.length) {
      console.log(`\n  Days still missing COGS: ${data.dataQuality.daysMissingCogs.join(', ')}`);
    }

    console.log(
      `\nSubscriptions    ${data.subscriptions.activeSubs.toLocaleString('en-GB')} active, ` +
        `${data.subscriptions.subsInDunning.toLocaleString('en-GB')} in dunning`,
    );
    console.log(
      `  cancelled ${data.subscriptions.cancelledSubs} (${data.subscriptions.voluntaryCancels} voluntary, ${data.subscriptions.dunningCancels} dunning)`,
    );
    break;
  }

  case 'mrr':
  case 'subscriptions': {
    const data = await subscriptions(range);
    if (has('json')) { dump(data); break; }

    heading(`MRR as of ${data.revenue.snapshotDate}`);
    console.log(describeMrr(data.revenue));
    console.log(
      `\nFour-week ${formatEur(data.revenue.mrrFourWeek)} — Skio's own convention, for reconciling against their dashboard only.`,
    );
    console.log(
      `\n${data.revenue.subsBillingMoreThanOnce} subs bill twice inside the 30-day window ` +
        `(28-day cycle vs 30-day horizon). That is intentional: the ceiling is a cash question.`,
    );
    console.log(`${data.revenue.pausedSubs} paused subs excluded (${formatEur(data.revenue.pausedAmountExcluded)}).`);

    const recent = data.movements.slice(-3);
    if (recent.length) {
      heading('Recent movement in the ceiling');
      for (const movement of recent) console.log(explainMovement(movement), '');
      console.log(
        'Reminder: the ceiling moves on window roll alone. Decompose before calling any drop churn.',
      );
    }
    break;
  }

  case 'daily': {
    const data = await daily(range);
    if (has('json')) { dump(data); break; }
    heading('Daily series');
    console.log('date         revenue      ad spend      profit     margin  est?');
    for (const day of data.days as Array<Record<string, number | string | boolean>>) {
      const estimated = day.profitIsEstimated ? ' est' : '';
      console.log(
        `${String(day.date).slice(0, 10)}  ` +
          `${formatEur(Number(day.revenueEur ?? 0)).padStart(11)}  ` +
          `${formatEur(Number(day.adSpendEur ?? 0)).padStart(11)}  ` +
          `${formatEur(Number(day.profitEur ?? 0)).padStart(10)}  ` +
          `${(Number(day.marginPct ?? 0) * 100).toFixed(1).padStart(6)}%${estimated}`,
      );
    }
    console.log('\n"est" means COGS for that day was a 40% estimate, not a measured cost.');
    break;
  }

  case 'ads': {
    dump(await ads(range));
    break;
  }

  case 'health':
  case 'sync': {
    const data = await syncStatus();
    dump(data);
    console.log('\nIf a source is far behind, the numbers above it are stale. Say so before quoting them.');
    break;
  }

  case 'raw': {
    const path = rest[0];
    if (!path) {
      console.error('Usage: profit.ts raw /api/<path> [--days N | --from ... --to ...]');
      process.exit(1);
    }
    dump(await apiGet(path.replace(/^\/api/, ''), range));
    break;
  }

  default:
    console.error(
      `Unknown command "${command}".\n` +
        'Available: summary | mrr | daily | ads | health | raw <path>\n' +
        'Flags: --days N | --from YYYY-MM-DD --to YYYY-MM-DD | --json',
    );
    process.exit(1);
}
