/**
 * Creative performance from Meta, grouped the way the team thinks about it.
 *
 *   creatives.ts --days 14                 group by hook variant (the default)
 *   creatives.ts --days 30 --by editor
 *   creatives.ts --days 30 --by concept
 *   creatives.ts --days 7  --by ad --csv /home/app/workspace/ads.csv
 *
 * Flags: --from/--to YYYY-MM-DD | --min-spend N | --sort spend|roas|hookRate
 *        | --refresh | --csv path | --json
 *
 * All ratios are computed as SUM(numerator)/SUM(denominator) across the range.
 * Never average a per-day rate.
 */
import { writeFileSync } from 'node:fs';

import { cached } from '/home/app/kit/lib/cache.ts';
import { formatEur } from '/home/app/kit/lib/fx.ts';
import { metaAdAccountIds } from '/home/app/kit/lib/env.ts';
import {
  type AdInsightRow,
  type AdRecord,
  adInsights,
  adsByIds,
  isVideoCreative,
  purchases,
  videoKeyOf,
  videoRetention,
} from '/home/app/kit/lib/meta.ts';
import { parseCreativeName, resolveCreativeName, variantKeyOf } from '/home/app/kit/lib/creativeName.ts';
import { parseArgs } from '/home/app/kit/lib/args.ts';

const { command, rest, flag, has } = parseArgs({ value: ['by', 'sort', 'min-spend'], boolean: ['refresh'] });



const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const until = flag('to') ?? day(-1); // yesterday: today is always partial
const since = flag('from') ?? day(-Number(flag('days') ?? 14));
const groupBy = (flag('by') ?? 'variant') as 'variant' | 'editor' | 'concept' | 'ad';
const minSpend = Number(flag('min-spend') ?? 0);
const sortBy = (flag('sort') ?? 'spend') as 'spend' | 'roas' | 'hookRate';

// ---------------------------------------------------------------- the pull

const cacheKey = `meta/insights-${since}_${until}`;
// One hour. Meta restates conversions for ~72 hours, so a longer cache would
// serve numbers that have since been revised.
const rows = await cached<AdInsightRow[]>(cacheKey, has('refresh') ? 0 : 3_600_000, async () => {
  const all: AdInsightRow[] = [];
  for (const accountId of metaAdAccountIds()) {
    process.stderr.write(`  pulling ${accountId} ${since}..${until}\n`);
    all.push(...(await adInsights(accountId, since, until)));
  }
  return all;
});

const adIds = [...new Set(rows.map((row) => row.ad_id))];
const ads = await cached<Record<string, AdRecord>>(
  `meta/ads-${since}_${until}`,
  has('refresh') ? 0 : 24 * 3_600_000,
  async () => {
    process.stderr.write(`  fetching ${adIds.length} ad records (50 per call)\n`);
    return Object.fromEntries(await adsByIds(adIds));
  },
);

// ------------------------------------------------------------- aggregation

interface Totals {
  key: string;
  label: string;
  editor: string;
  concept: string;
  hook: string;
  ads: Set<string>;
  videoKeys: Set<string>;
  spend: number;
  impressions: number;
  linkClicks: number;
  plays3s: number;
  thruplays: number;
  p25: number;
  p100: number;
  purchaseCount: number;
  revenue: number;
}

const groups = new Map<string, Totals>();
let nonVideo = { ads: 0, impressions: 0, spend: 0 };

for (const row of rows) {
  const ad = ads[row.ad_id];
  const creative = ad?.creative;

  // Non-video ads are excluded from creative analysis, but counted so the
  // exclusion is visible rather than silent.
  if (ad && !isVideoCreative(creative)) {
    nonVideo = {
      ads: nonVideo.ads + 1,
      impressions: nonVideo.impressions + Number(row.impressions ?? 0),
      spend: nonVideo.spend + Number(row.spend ?? 0),
    };
    continue;
  }

  const resolved = resolveCreativeName({
    creativeName: creative?.name,
    videoTitle: creative?.object_story_spec?.video_data?.title,
    adName: ad?.name ?? row.ad_name,
  });
  const parsed = resolved.parsed;

  let key: string;
  let label: string;
  switch (groupBy) {
    case 'ad':
      key = row.ad_id;
      label = (ad?.name ?? row.ad_name ?? row.ad_id).slice(0, 60);
      break;
    case 'editor':
      key = parsed.editor ?? 'unassigned';
      label = parsed.editor ?? 'unassigned';
      break;
    case 'concept':
      key = parsed.conceptId ?? 'unassigned';
      label = parsed.conceptId ? `concept ${parsed.conceptId}` : 'unassigned';
      break;
    default:
      key = variantKeyOf(parsed) ?? 'unassigned';
      label = key;
  }

  let group = groups.get(key);
  if (!group) {
    group = {
      key,
      label,
      editor: parsed.editor ?? 'unassigned',
      concept: parsed.conceptId ?? '',
      hook: parsed.hook ?? '',
      ads: new Set(),
      videoKeys: new Set(),
      spend: 0,
      impressions: 0,
      linkClicks: 0,
      plays3s: 0,
      thruplays: 0,
      p25: 0,
      p100: 0,
      purchaseCount: 0,
      revenue: 0,
    };
    groups.set(key, group);
  }

  const retention = videoRetention(row);
  const bought = purchases(row);
  const videoKey = ad ? videoKeyOf(ad) : null;

  group.ads.add(row.ad_id);
  if (videoKey) group.videoKeys.add(videoKey);
  group.spend += Number(row.spend ?? 0);
  group.impressions += Number(row.impressions ?? 0);
  group.linkClicks += Number(row.inline_link_clicks ?? 0);
  group.plays3s += retention.plays3s;
  group.thruplays += retention.thruplays;
  group.p25 += retention.p25;
  group.p100 += retention.p100;
  group.purchaseCount += bought.count;
  group.revenue += bought.valueNative;
}

// Ratios computed here, once, over summed numerators and denominators.
const divide = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

const report = [...groups.values()]
  .filter((g) => g.spend >= minSpend)
  .map((g) => ({
    group: g.label,
    editor: g.editor,
    ads: g.ads.size,
    videos: g.videoKeys.size,
    spend: Number(g.spend.toFixed(2)),
    revenue: Number(g.revenue.toFixed(2)),
    roas: Number(divide(g.revenue, g.spend).toFixed(2)),
    purchases: g.purchaseCount,
    impressions: g.impressions,
    hookRate: Number((divide(g.plays3s, g.impressions) * 100).toFixed(2)),
    holdRate: Number((divide(g.thruplays, g.plays3s) * 100).toFixed(2)),
    ctr: Number((divide(g.linkClicks, g.impressions) * 100).toFixed(2)),
    dropOff: Number(((1 - divide(g.p100, g.p25)) * 100).toFixed(1)),
  }))
  .sort((a, b) => (sortBy === 'roas' ? b.roas - a.roas : sortBy === 'hookRate' ? b.hookRate - a.hookRate : b.spend - a.spend));

// ------------------------------------------------------------------ output

if (flag('csv')) {
  const headers = Object.keys(report[0] ?? {});
  const csv = [
    headers.join(','),
    ...report.map((r) => headers.map((h) => JSON.stringify((r as Record<string, unknown>)[h] ?? '')).join(',')),
  ];
  writeFileSync(flag('csv')!, csv.join('\n'), 'utf8');
  console.log(`${report.length} rows -> ${flag('csv')}`);
} else if (has('json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const noun = { variant: 'hook variant', editor: 'editor', concept: 'concept', ad: 'ad' }[groupBy];
  console.log(`\nMeta creative performance by ${noun}, ${since} to ${until}`);
  console.log(`${rows.length} ad-days across ${adIds.length} ads\n`);
  console.table(report.slice(0, 30));

  const totalSpend = report.reduce((sum, r) => sum + r.spend, 0);
  const unassigned = report.find((r) => r.group === 'unassigned' || r.editor === 'unassigned');
  console.log(`Total spend ${formatEur(totalSpend)} across ${report.length} ${noun}s.`);

  if (unassigned) {
    console.log(
      `\nUnassigned: ${formatEur(unassigned.spend)} (${((unassigned.spend / totalSpend) * 100).toFixed(1)}% of spend), ` +
        `${unassigned.impressions.toLocaleString('en-GB')} impressions across ${unassigned.ads} ads.\n` +
        `These are named as ad copy rather than by convention, so no editor could be identified.\n` +
        `This is normal — report it, don't drop it.`,
    );
  }
  if (nonVideo.ads > 0) {
    console.log(
      `\nExcluded ${nonVideo.ads} non-video ad-days (${formatEur(nonVideo.spend)}, ` +
        `${nonVideo.impressions.toLocaleString('en-GB')} impressions) — creative analysis is video only.`,
    );
  }

  console.log(
    `\nRates are SUM(numerator)/SUM(denominator) over the whole range, never averaged per day.\n` +
      `Revenue is omni_purchase only. Meta restates conversions for ~72h, so recent days are provisional.`,
  );
}
