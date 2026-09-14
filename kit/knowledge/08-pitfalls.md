# Pitfalls — every way these numbers have been gotten wrong

If you read one file before touching Scandi data, make it this one. Every item below
is a real mistake that was made and then corrected, recovered from source comments
and docs.

## Profit & COGS

- **Blank COGS is not zero COGS.** The sheet treats an unfilled COGS cell as 0, which
  produced a 50.77% margin on 28 Jul 2026. Substitute the 40% estimate — and then
  **always carry the `isEstimated` flag** through to whatever you show. An estimated
  profit presented as measured is worse than no number.
- **True Profit is contribution margin, not net profit.** No salaries, overhead,
  SaaS, or financing cost. Say so when you report it.
- **Don't subtract refunds twice.** They're already netted inside `total_sales`, on
  the refund date.
- **`profitExcludingSubs` uses the 40% estimate even when actual COGS exists**, and
  omits gateway fees. It's a different question. Don't mix it with True Profit.
- **Never add projected subscription profit to True Profit.** One is realised, one is
  a forward projection at a 57% assumed margin.
- **Don't recompute profit from raw APIs when the Profit API can answer it.** It
  already resolves ad-spend precedence, effective-dated rates and COGS fallback. Going
  around it is how those rules get silently dropped. Its `/api/summary` also hands you
  `cogs.estimatedShareOfRevenue` — **quote it next to the margin.** A live 7-day read
  showed a 30.7% margin where 25.9% of revenue carried an assumed COGS.

## Ad spend

- **Never add Meta API spend to Triple Whale spend.** Double-counts Facebook. Use
  `ads_daily`, which resolves precedence.
- **The sheet's historical Facebook column is single-account.** The app blends two.
  They will disagree before the handover date of `2026-07-28`, and that's correct.
- **Meta conversion data drifts for ~72 hours.** Yesterday's number pulled today is
  provisional.
- **The Juni trap.** For Aug 1–12 2026, Meta charges vanished from the Revolut
  statement and reappeared as Juni card-facility transfers. Bank-derived ad spend for
  that window shows a fake efficiency spike. Total ads = visible + Juni. The only
  clean bank-derived ROAS window is **13–24 Aug 2026**.
- **New Meta ad accounts arrive disabled.** That's deliberate — don't blanket-enable
  `include_in_blended`.

## Subscriptions & MRR

- **`cyclesCompleted` includes the checkout as cycle 1.** Never-rebilled is `<= 1`,
  not `== 0`. Off-by-one here shifts every cohort.
- **"MRR" is ambiguous** because the billing interval is 28 days, not a month. Four
  framings span €442k–€605k on the same day, so a bare "MRR is X" is never complete.
  **Lead with the 30-day ceiling** — it's the house number, the dashboard headline and
  the sheet's `Total MRR (Skio)` — but **always report calendar MRR alongside it and
  offer to explain the difference.** Add **realistic** when the question is about cash
  we'll really see, and **four-week** only to reconcile against Skio's own UI.
- **The ceiling's day-over-day change is not growth.** A rolling 30-day window over
  28-day cycles captures a different charge count each day, so the ceiling oscillates
  with zero net adds and zero churn. That artefact lands in `movements[].residual` —
  which was −€9,130 of a −€15,238 move on 2026-09-02. This is the one case where you
  lead with calendar instead: decompose the bridge before attributing any drop to
  churn.
- **The risk haircut is derived, not fixed.** It has sat near 21.3% twice, but read
  `haircutPct` rather than hardcoding it.
- **MRR figures are a nightly derive, not live.** `revenue.snapshotAt` says when they
  were computed; an intraday MRR question is answered by ~00:45 unless you read
  `skio_mrr_hourly`.
- **Checkout discounts don't recur; retention discounts do.** `FLEXIBLE30` (held by
  1,102 subs) does not apply on rebills. `CANCEL_DISCOUNT` does.
- **`FREE_SHIPPING` does not cancel the €5.99 shipping fee.** 336 subs hold both.
- **Pooled shipping history is misleading.** Only 4.3% of recent rebills carried a
  fee because they came from pre-rule subs. Validate by **cohort**, not pool.
- **FX failure converts to zero, it doesn't error.** A provider outage on 25 Aug 2026
  turned an observed €519k into €431k with no warning. Assert FX coverage (limit: 1%
  of subs uncovered) before publishing any converted total.
- **A light incremental Skio sync must not null out `deliveryPrice`.** Silently
  undercounts MRR.
- **The priced base must be <6h old** or MRR undercounts new subscribers.
- **`statusContext` is overwritten in place** — dunning is only observable live.
  Historical dunning cannot be reconstructed.
- **Reconstructed historical active-sub counts overstate by ~15%.**
- **Dunning: use `fresh_not_billed`, not `subs_due`.** The retry pool inflates it —
  one day read 1,482 failed payments when the truth was 42.
- **Don't pool voluntary cancels with dunning cancels.** Different problem,
  different fix. Genuine cancel = `CANCELLED` with no `statusContext`.

## Shopify

- **Use Shopify's reported AOV, not revenue ÷ orders** — they differ by 1–6%. And the
  reported figure is **single-day only**; it can't be summed or averaged.
- **Bulk JSONL on API 2026-01 has `groupObjects: false` by default.** Line items
  arrive as flat rows with `__parentId`. Reassemble them.
- **€0 freebies (Shade Guide, Progress Tracker) block whole-order fulfilment
  status.** Always separate freebie-blocked from genuinely unshipped when counting
  backlog.
- **`deliveredAt` is unreliable** and `displayFulfillmentStatus` can disagree with
  per-fulfilment `displayStatus`. Check both.
- **Free packs on the 6 and 8 tiers are a separate product line.** COGS that counts
  only the main line understates cost.
- **Reshipped orders**: the old sheet capped this at 5/day. Real counts are 8–9+.
- Order counts drift on past days even when revenue is stable.

## Skio API

- **Filter on `createdAt`/`updatedAt`, never `subscriptionBillingDate`.** The latter
  takes 7+ minutes and times out; the former returns in 5 seconds. Almost nothing is
  indexed. Pull on a watermark, analyse in Postgres.
- **Introspection is enabled — use it.** The original field set was assembled by
  guessing names and reading errors, which is how `BillingAttempts`, `AuditLog` and
  the cancel-flow tables went unnoticed for a long time.

## 17track

- **Registration costs quota and is permanent.** Check Shopify `deliveredAt` first;
  probe `gettrackinfo` before registering.
- **PostNL needs `destination_postal_code`**, and may need the zip without spaces.
- **"No info" means never registered**, not a lost parcel.
- Error `-18019908` = quota exhausted, registration silently stops.

## Creative & ad analysis

- **"A video" means a hook variant**, not a file and not an ad. One variant can span
  many files and dozens of ads. Group by editor + concept + hook + iteration.
- **Concept IDs are not unique across editors.** Editor and concept are both required
  to identify a variant.
- **Sum `omni_purchase` only.** The actions array holds several aliases of the same
  conversion; adding them multiplies revenue several times over.
- **Hook rate uses `video_view` (3s plays), not `video_play_actions`** — the latter
  counts any play start and lands at ~96% of impressions, which is meaningless.
- **Anchor the drop-off curve at impressions, not plays.** Anchoring at plays hides
  the largest drop of all: people who never started watching.
- **Never rank creatives by ROAS.** A €12 test that converted once will beat a €9,000
  winner. Rank on an additive volume metric; use ROAS to split rewards or to scout,
  always behind a spend floor.
- **Never average per-video ROAS.** Summed revenue ÷ summed spend, always.
- **Retention columns are nullable on purpose.** Each metric entered the sync on a
  different day; treating NULL as 0 makes a smaller sample look like a real decline.
  Each needs its own filtered denominator.
- **Strip date-shaped substrings before parsing a concept ID**, or `2026` in a
  filename gets read as the concept.
- **Match editor tokens longest-first with non-letter boundaries**, or `DAVID` eats
  `DAVIDPLATA` and `LAU` eats `CLAUDIA`.
- **Unassigned creatives are normal** — ad-copy-named creatives parse to no editor.
  Report that volume explicitly rather than silently dropping it.
- **Exclude non-video ads** from creative analysis.
- **Volume is extremely concentrated** — one editor held 82.8% of impressions in a
  recent month. Team averages hide this; show the distribution.
- **Launch dates only exist for creatives logged in the tracker sheet.** A creative
  nobody logged cannot appear in launch-date-dependent views.
- **Each retention rate has its own filtered denominator.** Hook/hold divide by
  impressions where `three_sec_views IS NOT NULL`, CTR by impressions where
  `link_clicks IS NOT NULL`, and so on. A plain `SUM(impressions)` for all of them
  understates every rate.
- **The `videos` table holds files, not hook variants.** Several rows can be
  re-exports of one variant. Don't report its row count as "number of videos".
- **Strategist attribution is not live** — all credit currently lands on Gabriela.
  Never present strategist numbers as a real split.
- **Editor Games has no FX conversion.** It assumes EUR and only logs a warning if
  accounts report in mixed currencies, so cross-account totals can be silently wrong.
- **Pay periods run on `Europe/Rome`, the profit dashboard on `Europe/Stockholm`.**
  Don't assume a shared day boundary when reconciling the two.
- **`time_range` is ignored by Meta's `/ads` edge** (it only works on Insights).
  Filter `created_time` and verify client-side.
- **CPA, CPM and thumbstop rate don't exist** in Editor Games. Don't cite them as if
  they're available.

## Ratios & aggregation

- **Never average per-day ratios.** Every ratio is
  `SUM(numerator) / SUM(denominator)` over the range. The daily tables store only
  additive components specifically so this can't go wrong.
- **Blended breakeven ROAS is `1 / revenue-weighted margin`**, not the average of
  per-market breakevens.
- **Breakeven ROAS is horizon-dependent.** Quoting one without a payback horizon is
  meaningless.

## Operational

- **The worker must be running** for the Profit API to serve fresh data. Check
  `GET /api/sync/status` first.
- **Sheet sync halts on column layout mismatch by design.** If someone inserts a
  column, it stops rather than writing to the wrong place.
- **The retention curve has a cliff at cycle 2→3 (~45%)**, between much higher rates
  either side. Any smooth-decay LTV model will be badly wrong.
- **There is no VAT.** Don't add a VAT line, and don't treat gross and net as
  different at company level.
