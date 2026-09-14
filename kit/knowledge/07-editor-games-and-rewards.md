# Editor Games — Creative Metrics, Leaderboard & Rewards

The internal dashboard that shows each video editor what their creatives earned and
how much of the bonus pool they're on track to take home. It is also **the best
reference for how Scandi uses the Meta API at creative level**.

Source: `d:\scandi\scandi-editor-games`.

## The design principle that governs everything

> **Every stored column is a count, never a rate.**
>
> Meta serves ready-made rates, but a rate that arrives per day cannot be
> re-aggregated into a range — and the "unique" variants divide by reach, which is
> not additive at all. Storing numerators and dividing at read time is the whole
> reason any date range can be answered from stored data.

Meta insights are pulled at their **raw grain — one row per ad per day** — into
Postgres. Every view (a pay period, "last 7 days", an arbitrary custom range) is a
SQL aggregation over that table. New views never require re-pulling.

This mirrors the same rule in the profit dashboard, and it's the single most
important habit to carry into any new creative analysis.

## Data model

Tables: `ad_accounts`, `editors`, `videos`, `ads`, `daily_ad_stats`,
`tracker_creatives`, `settings`, `pay_periods`, `sessions`, `sync_runs`.

```
ad_accounts (1) ──< ads (many)
videos      (1) ──< ads (many)              ads.video_key → videos.video_key
ads         (1) ──< daily_ad_stats (many)   PK: (date, ad_id)
editors     (1) ──< videos (many)
tracker_creatives ── joined on variant_key, not by FK
```

Two naming traps in this schema:

- **The table is called `videos`, but it holds files, not hook variants.** Every
  leaderboard and editor view rolls up to hook variant, so multiple `videos` rows
  (re-exports of the same cut) sum into one variant. Don't report `videos` row counts
  as "number of videos".
- **`video_key` is the Meta `video_id` when there is one, otherwise
  `name:{UPPERCASE_NAME}`.** The fallback is what keeps non-video or
  missing-asset ads addressable. Non-video ads get `video_key = null` and an
  `is_video` flag that excludes them from the leaderboard.

Stored columns on `daily_ad_stats`: `impressions`, `spend`, `revenue`, `purchases`,
`clicks`, `link_clicks`, `three_sec_views`, `thruplays`,
`video_p25 / p50 / p75 / p95 / p100`.

> `purchases` is synced but **never displayed**. `clicks` is stored but CTR uses
> `link_clicks` instead.

## The creative metrics

| Shown as | Numerator | Divided by |
|---|---|---|
| **ROAS** | `omni_purchase` value | Spend |
| **Hook rate** | 3-second plays (`video_view`) | Impressions |
| **Hold rate** | ThruPlays — complete, or 15s, whichever is first | Impressions |
| **CTR** | `inline_link_clicks`, link clicks only | Impressions |
| **Drop-off** | Plays reaching 25 / 50 / 75 / 95 / 100% | Impressions |

```typescript
export function roasOf(revenue: number, spend: number): number | null {
  return spend > 0 ? revenue / spend : null;
}
export function rateOf(count: number, impressions: number): number | null {
  return impressions > 0 ? count / impressions : null;
}
```

Both return **null, not 0**, when the denominator is zero — so the UI shows a dash
rather than implying a real 0%.

### Three metric definitions that are easy to get wrong

**ROAS is summed revenue ÷ summed spend, never an average of per-video ROAS.**
An average would weight a €2 test the same as a €5,000 winner and would not
reconcile with Ads Manager.

**Hook rate uses `video_view`, not `video_play_actions`.**

> Meta counts a `video_view` when playback reaches 3 seconds (or ~97% of a shorter
> clip), excluding replays. It is deliberately not `video_play_actions`, which counts
> any play start and lands at ~96% of impressions.

**Revenue comes from `omni_purchase` only.**

> `omni_purchase` is Meta's unified purchase event and the same action type behind
> Ads Manager's `purchase_roas`. Only one action type is ever summed: the array holds
> many aliases of the same conversion (`purchase`,
> `offsite_conversion.fb_pixel_purchase`, …) and **adding them would multiply revenue
> several times over.**

### The drop-off curve

> **Anchored at impressions, not at plays.** Anchoring at plays would flatter every
> creative by hiding the largest drop of all: the people who never started watching.

Meta reports exactly **six moments** — 3 seconds, then 25/50/75/95/100%. There is no
10% or 90% field. The curve is those six points and the straight lines between them.
Clip lengths from Drive are what let "25%" be read as a timestamp.

### Retention columns are nullable, and that is load-bearing

> Each metric was added to the sync on a different day, so rows written before then
> hold **NULL rather than zero**, and each one is divided by impressions *from the
> days it was actually measured on*. A zero would quietly drag a range's rate down in
> proportion to how much of that range predates the metric — which reads as a real
> decline rather than as a smaller sample.

Adding a metric therefore means: a new nullable column, **its own filtered
denominator**, and a backfill. Each rate has a *different* denominator:

```sql
RETENTION_IMPRESSIONS  = SUM(s.impressions) FILTER (WHERE s.three_sec_views IS NOT NULL)
CTR_IMPRESSIONS        = SUM(s.impressions) FILTER (WHERE s.link_clicks     IS NOT NULL)
COMPLETION_IMPRESSIONS = SUM(s.impressions) FILTER (WHERE s.video_p75       IS NOT NULL)
MILESTONE_IMPRESSIONS  = SUM(s.impressions) FILTER (WHERE s.video_p25       IS NOT NULL)
```

Hook and hold rate divide by `RETENTION_IMPRESSIONS`, CTR by `CTR_IMPRESSIONS`, and
so on. **Using a single plain `SUM(impressions)` for all of them is wrong** and will
understate every rate over any range that predates a metric's introduction.

## Metrics that do NOT exist here

Don't assume these are available — none are implemented:

- **CPA** and **CPM** — not computed anywhere
- **Thumbstop rate** — not a named metric; functionally the same as hook rate
- **Conversion/purchase counts** — stored, never surfaced
- **Unique / reach-based metrics** — deliberately avoided, since reach isn't additive

**ROAS green threshold** in the UI defaults to **1.70** (admin-configurable) — a
useful implicit benchmark for what the team considers a good creative.

## The editor roster

Seeded from `DEFAULT_EDITORS`; admins can edit tokens afterwards. `onLeaderboard`
controls whether they're paid from the pool.

| Editor | Tokens | On leaderboard |
|---|---|---|
| Cristian | `CRIS` | ✅ |
| Adriian | `ADRI` | ✅ |
| Laura | `LAU` | ✅ |
| David | `DAVIDPLATA`, `DAVID` | ✅ |
| Randolph | `RANDOLPH` | ✅ |
| Sharon | `SHARON` | ✅ |
| Zulu | `ZULU` | ❌ legacy |
| Mar | `MAR` | ❌ legacy |
| Javid | `JAVID` | ❌ |
| Isaac | `ISAAC` | ❌ |

> Volume is extremely concentrated. In the 30 days to 2026-07-25, Cristian held
> **82.8% of impressions** (4.5M, €49.7k spend, 1.94× ROAS) against Adriian's 15.5%.
> Any "team average" hides this — always show the distribution.

## The bonus pool

Each pay period has a **bonus pool split between active leaderboard editors in
proportion to a configurable metric**. Base per-video pay is handled outside the app.

Seeded defaults (all admin-editable, so **verify before quoting**):

| Setting | Default |
|---|---|
| `poolAmount` | **€800** |
| `periodLengthDays` | **15** |
| `distributionMetric` | `impressions` |
| `minSpendToQualify` | **0** |
| `timezone` | **`Europe/Rome`** |

> ⚠️ Pay periods run on **Europe/Rome**, while the profit dashboard uses
> **Europe/Stockholm**. Same offset most of the year, but don't assume a shared day
> boundary when reconciling the two systems.

```typescript
const qualified = totals.filter((t) => t.spend >= minSpendToQualify);
const denominator = qualified.reduce((sum, t) => sum + metricValue(t, metric), 0);
const share = isQualified && denominator > 0 ? metricValue(t, metric) / denominator : 0;
projectedBonus = share * pool;
```

> **Legacy editors' still-running videos are deliberately not in the denominator:**
> they are not being paid, so counting them would silently shrink everyone's share.

Disqualified editors keep their stats but take no share, and the pool is
redistributed across those who qualify. `minSpendToQualify` guards ROAS mode against
flukes.

## The ranking metric setting

One admin setting decides **both** how the pool is divided and what the whole app
treats as "best":

| Setting | Pool split by | Boards ranked by |
|---|---|---|
| `impressions` *(default)* | Impressions | Impressions |
| `spend` | Spend | Spend |
| `roas` | ROAS | **Impressions** |

> Ranking and paying are one setting rather than two because they are the same
> judgement. The number an editor is paid on is the number they should see themselves
> ranked by.

**ROAS is the deliberate exception.** It's a ratio, and ordering a hundred creatives
by a ratio puts a €12 test that converted once above a €9,000 winner. So ROAS splits
the pool while rankings stay on delivery:

```typescript
export type RankMetric = "impressions" | "spend";
export function rankMetricOf(metric: DistributionMetric): RankMetric {
  return metric === "spend" ? "spend" : "impressions";
}
```

**Only additive volume metrics can carry an ordering.** This is a good general rule
for any ranking you build for this brand.

## Creative strategists

A separate role with its own login. The two strategists are **Gabriela** and
**Belen**.

Payout is per **concept**, not per hook variant:

| Rule | Value |
|---|---|
| Qualifying threshold | **€500 lifetime spend** on a concept, summed across all its hooks and ads |
| Fee | **€60** per qualifying concept (admin-editable) |
| Cap | **€1,000** per strategist per pay period |
| Credited to | The pay period containing `crossedOn` — the day cumulative spend first hit €500 |
| Arrangement start | **2026-07-16** — concepts crossing before this are excluded |

> ⚠️ **Attribution is not live.** `STRATEGIST_ATTRIBUTION_READY = false`, so **every
> winning concept is currently credited to Gabriela** and the UI flags
> `attributionPending: true`. The plan is a code in the ad name. `strategistOf` in
> `apps/api/src/services/strategist.ts` is the only place that changes when it lands.
>
> **Never present strategist numbers as a real split between the two of them.**

## "Potential new winners" — how a winner is spotted

A separate board from the leaderboard, and the reasoning is worth internalising:

> The five best-returning creatives that launched in the **last seven days**, above a
> **€50 spend floor**. It ignores the selected range on purpose. The leaderboard ranks
> on volume, which is the right thing to pay on and the wrong thing to spot a winner
> with: **a video three days old cannot out-deliver one that has been scaling a
> fortnight, however well it converts.** This ranks on return over a fixed recent
> window instead, so something worth scaling is seen while scaling it still helps.
> The spend floor is what stops it being won by a creative that spent four euros and
> got lucky — with a denominator that small, ROAS is measuring noise.

**Pay on volume, scout on return, always with a spend floor.** That is the house
philosophy for creative decisions.

Board sizes, for reference: podium **3**, preview strip ranks **4–8**, top-videos page
**20** (paginated 10 at a time), new winners **5**.

Range presets available: `current_period`, `previous_period`, `last_7d`, `last_14d`,
`last_30d`, `custom`, or an explicit `periodIndex`.

## The phone prize contest

A one-off contest running alongside the pool, hardcoded in `packages/shared/src/api.ts`:

```typescript
export const PRIZE_START_DATE = "2026-08-15";
export const PRIZE_END_DATE   = "2026-09-15";
export const PRIZE_NAME       = "iPhone 18 Pro";
export const PRIZE_VALUE      = 1300;
```

Won by **most spend** in that fixed window — deliberately ignoring
`distributionMetric`. Eligible: active, on-leaderboard editors with spend > 0.
`behindBy` shows the gap to the leader.

> This window has passed as of the current date. Check whether it was renewed before
> mentioning it as live.

## Not getting rate limited by Meta

> Meta's rate limit budget **shrinks when you generate errors**, so a misbehaving
> integration digs its own hole.

The layered safeguards, worth replicating in any new Meta code:

- **Request shape** — only needed fields, server-side filtering to ads that actually
  delivered, pinned API version, pinned attribution windows
- **Pacing and backoff** — minimum delay between calls, exponential backoff on
  retryable codes, retries on transport failures
- **Throttle monitoring** — read `x-fb-ads-insights-throttle` and
  `x-business-use-case-usage` on every response; **pause above 80% utilisation**.
  Peak utilisation is recorded per run (typically sits at 2–8%)
- **A Postgres advisory lock** so two instances can never sync at once
- **A minimum interval** between runs that even "Sync now" respects
- **A circuit breaker** — after three consecutive failures, syncing stands down for
  30 minutes

Client constants:

```typescript
const PACING_DELAY_MS    = 400;      // base delay between consecutive calls
const HIGH_UTIL_DELAY_MS = 30_000;   // extra pause when throttle utilization > 80%
const MAX_RETRIES        = 5;
const REQUEST_TIMEOUT_MS = 120_000;  // wide insight queries are legitimately slow
```

Schedule:

| Job | Cron | Window |
|---|---|---|
| Shallow sync | `7 */N * * *` (hourly) | last **3 days** |
| Deep sync | `20 4 * * *` (nightly) | last **35 days** — catches retroactive conversions |
| Tracker sync | hourly at `:37` | full tab reconcile |
| Boot | 10s after start | shallow + tracker |

Guards: advisory lock, **5-minute minimum interval**, 3-failure circuit breaker with
a 30-minute cooldown. The tracker sync has its own lock and schedule, so a spreadsheet
read and a Meta pull never block each other.

## Currency caveat

Ad accounts are **discovered at runtime** from the token — no account IDs are
hardcoded in the repo. The app assumes **EUR** throughout.

> ⚠️ **If accounts report in mixed currencies, the app logs a warning and the totals
> may simply be wrong** — there is no FX conversion in this pipeline, unlike the
> profit dashboard. Check the accounts list (`npm run accounts` in that repo) before trusting
> cross-account totals.

## Roles and access

Three shared passwords: **viewer**, **admin**, and an optional **strategist** login.
A strategist sees everything an editor sees plus the payout card. Admins see the same
card below the standings; editors do not.

## There is already an AI coach

`/coach` is a chat agent that can read all of the above and answer questions about
creative performance. It runs as a **separate deployment**; this app only holds its
URL (`AGENT_API_URL`, `AGENT_API_KEY`). Admin-only: the coach's settings, and
**Conversations**, where every chat is readable with who asked, from where, and which
tools it reached for.

> Worth reviewing before building anything similar — it may already do part of
> the job.

## Environment variables

| Variable | Purpose |
|---|---|
| `META_APP_TOKEN` | System-user token with `ads_read` on the ad accounts |
| `DATABASE_URL` | Postgres |
| `VIEWER_PASSWORD_HASH` / `ADMIN_PASSWORD_HASH` / `STRATEGIST_PASSWORD_HASH` | argon2id hashes |
| `SESSION_SECRET` | 32+ random bytes |
| `ENABLE_CRON` | `false` runs the API without background sync |
| `GOOGLE_SERVICE_ACCOUNT_KEY` / `GOOGLE_SHEET_ID` | Creative tracker; optional as a pair |
| `AGENT_API_URL` / `AGENT_API_KEY` | The AI coach |

Without the Google pair the app runs "exactly as before, minus launch dates, Drive
links, thumbnails and clip lengths."

## Useful scripts in that repo (not runnable from Jarvis)

| Command | What it does |
|---|---|
| `npm run accounts` | List the ad accounts the token can see |
| `npm run backfill -- --days 180` | Historical pull, chunked by month |
| `npm run sync -- --deep` | Full-window sync now |
| `npm run inspect` | Data-quality check on what the sync stored |
| `npm run audit:retention` | Reconcile stored retention against Meta's own numbers |
| `npm run sheet:explore` | List spreadsheets the service account can reach |
