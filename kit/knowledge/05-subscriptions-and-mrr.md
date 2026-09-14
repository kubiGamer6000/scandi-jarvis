# Subscriptions, the Charge Model & MRR

Subscriptions are the business. This is also the area with the most subtle, hard-won
knowledge — nearly all of it empirically validated against real rebill orders rather
than assumed. Source: `d:\scandi\ultimate-scandi-app\src\metrics\skioModel.ts`,
`skioRevenue.ts`, `skioRisk.ts`.

## The rebill charge model

**Question it answers:** what will Skio actually charge this subscription on its next
billing date, in EUR?

```
charge = Σ(line.priceWithoutDiscount × quantity) × (1 − retention discount)
       + deliveryPrice
```

### What recurs and what doesn't

This is the crux, and it was determined by measurement, not by reading Skio's docs:

| Component | Recurs? | Evidence |
|---|---|---|
| Line price × quantity | ✅ full price | confirmed against rebill orders |
| `CANCEL_DISCOUNT` (retention offers) | ✅ yes | 1.1% of 1,858 rebills carried a discount, averaging 30.1% off — matches the ~78 subs holding a 20–35% CANCEL_DISCOUNT |
| `FLEXIBLE30` (34% off) and other checkout codes | ❌ **no** | if they recurred, far more than 1.1% of rebills would show a discount — 1,102 subs hold FLEXIBLE30 |
| `deliveryPrice` shipping fee | ✅ yes | validated by cohort |
| `FREE_SHIPPING` discount | ❌ does **not** cancel the fee | 336 post-rule subs hold both; honouring it underpredicts what those cohorts paid |

### Shipping fee detail

€5.99 (converted per currency) when the sub holds fewer than 6 packs. Rule live
~8–13 July 2026.

Pooled history is **misleading** here: only 4.3% of rebills in a recent 21-day window
carried shipping, because almost all came from pre-rule subs. Validated by cohort
instead — for the two newest cohorts, the share of subs carrying a stored fee (23.3%,
17.5%) matches the share of their rebills that charged one (27.0%, 21.7%), and the
amounts agree to the cent (€10.84 stored vs €10.78 charged).

The fee's weight keeps rising as pre-rule subs churn out: **60.8% of post-rule subs
carry one, against 4.2% of pre-rule ones.**

Subs created before `SHIPPING_RULE_LIVE_FROM = '2026-06-29'` have their stored
`deliveryPrice` ignored — those cohorts stored a fee on 5.9–14.5% of subs but only
collected one on 0.3–1.0% of rebills. This correction decays to a no-op over time.

### The cycle off-by-one

> A sub with `cyclesCompleted = c` has been billed **c** times (the checkout counts
> as 1), so its next rebill is tagged `Subscription Order: c+1` in Shopify.

So **never-rebilled** = `cyclesCompleted <= 1`. Getting this wrong shifts every
cohort by one.

## MRR — four different numbers

There is no single "MRR" here, because the billing interval is **28 days**, not a
month. Four framings exist. **All four are correct; they answer different questions.**

### How to report it

> **Lead with the 30-day ceiling — that's the house number.** It's the dashboard
> headline and what the profit sheet calls `Total MRR (Skio)`, so it's what David,
> Elias and Veli picture when they say "MRR".
>
> **Then give calendar MRR next to it, and offer the difference.** Not as a footnote —
> the two answer different questions and the gap is ~8%. Something like:
>
> *"30-day ceiling €561k — that's everything scheduled to bill in the next 30 days.
> Calendar MRR is €605k, which is the same book normalised to a real calendar month;
> it's the better one for growth comparisons. Want me to explain why they differ?"*
>
> **Never give a bare number.** "MRR is €561k" is incomplete — three other defensible
> figures span €442k to €605k on the same day.

Live reading, 2026-09-02, 8,984 active priced subs (`GET /api/subscriptions`):

| Framing | Field | Live | Role |
|---|---|---|---|
| **30-day ceiling** | `ceilingTotal` | €561,104 | **the house number** — cash scheduled to bill |
| **Calendar MRR** | `mrrCalendar` | €604,918 | **always pair it with the ceiling** — growth / run-rate |
| Four-week MRR | `mrrFourWeek` | €556,486 | only when reconciling with Skio's dashboard |
| Realistic | `realisticTotal` | €441,827 | what we expect to actually collect |

Bring in the other two when the question calls for them: **realistic** whenever the
question is about cash we'll really see, **four-week** only when someone is comparing
against Skio's own UI.

### 1. 30-day ceiling — the house number

Sum of every scheduled charge landing in the next **30 store-local days**, assuming
full collection. Paused subs (`statusContext = 'TEMPORARILY_PAUSED'`) excluded.

```typescript
for (const p of priced) {
  if (p.isPaused) continue;
  for (const t of billingSchedule(p, now, horizonDays)) {
    total += p.chargeEur;
  }
}
```

Because the interval is 28 days and the window is 30, **some subs bill twice** in the
window (248 of them, in the live reading). That is intentional and correct — it is a
cash question, not an accounting one. This is what gets written to the profit sheet as
`Total MRR (Skio)` and what the dashboard shows, which is why it's the number the team
quotes.

> ⚠️ **One exception to leading with it: do not read its day-over-day change as
> growth.** See below — this is the single most likely way to misreport MRR. For "did
> we grow?", lead with calendar instead and mention the ceiling second.

### 2. Calendar MRR — the growth companion

Each sub's next charge, normalised to a true calendar month:

```typescript
const DAYS_PER_MONTH = 365.2425 / 12;          // 30.436875
calendar += p.chargeEur * (DAYS_PER_MONTH / p.intervalDays);
```

For the dominant 28-day base that's a factor of **1.087** — which is exactly the
observed ratio (604,918 / 556,486 = 1.087).

It's a point-in-time normalised *rate*, so it only moves when the base, prices or
pauses move — it doesn't care where the window boundary falls. That's what makes it
**the figure to quote for growth**, and the live API spec says so explicitly.

It isn't a replacement for the ceiling; it's the number that goes **next to** it.

### 3. Four-week MRR — Skio's convention

One billing cycle counted as one "month", regardless of calendar length:

```typescript
skioFactor = interval === 'WEEK' ? 4 / count : interval === 'MONTH' ? 1 / count : ...;
```

For a 4-week sub that factor is 1, so this is essentially "sum of everyone's next
charge". Use it **only** when reconciling against Skio's UI. It understates a real
calendar month by ~8.5%, because 13 four-week cycles fit in a year, not 12. The profit
sheet no longer writes it; it's kept in the snapshot for continuity with older rows.

### 4. Realistic revenue — the honest forecast

The ceiling, risk-adjusted by chaining per-cycle collection probabilities, so a later
charge only counts if every earlier charge in its chain collects. The number to quote
when someone asks "what will we actually collect?"

```
haircutPct = (ceiling − expected) / ceiling
```

The haircut is **derived, not configured** — it moves with cohort collection rates,
the dunning pool and base composition. It happens to have sat near 21.3% both at the
2026-07-28 calibration (€227,672 → €179,283) and in the live 2026-09-02 read
(€561,104 → €441,827), but treat that as coincidence and read `haircutPct` rather than
hardcoding it.

Live risk inputs: cycle 1→2 **73.4%** collection, cycle 2→3 ~**45.7%** (the cliff),
steady state ~47.5%; permanent failure rate 9.6%; monthly cancel hazard 26.4%. Losses
split €45k to cancellation and €72k to payment failure — **failure is the larger
leak.**

### Why the ceiling drifts and calendar doesn't

This is the mechanical bit worth internalising, because it's the trap.

The ceiling window rolls forward one day at a time. Charges drop off the leading edge
and new ones enter at the trailing edge. With a **28-day** billing cycle inside a
**30-day** window, a given subscriber contributes one charge on some days and two on
others, depending purely on where their rebill date sits relative to the window edge.

Across the whole book that produces a **beat pattern**: the ceiling oscillates even
with zero net adds and zero churn. So `ceiling_today − ceiling_yesterday` mixes real
growth with pure window-roll artefact.

Calendar MRR has no window. It's a rate computed from the current base, so it moves
only when something real moves.

**How much does this matter?** On 2026-09-02 the ceiling fell €15,238. Only €6,108 of
that came from actual cohort events (new, recovered, cancelled, dunning). The
remaining **−€9,130 was residual** — mostly window roll. Attributing that whole
€15k drop to churn would have been wrong by a factor of two and a half.

## Billing schedule mechanics

A billing date already in the past means Skio is **retrying**, so it is pulled
forward to `now` rather than dropped.

For historical questions, today's `nextBillingDate` is wrong — Skio advances it on
every successful rebill. `nextBillingAsOf()` walks it backwards by the interval to
recover the schedule that was live on a past day:

> If a sub now shows 5 Sep and bills every 28 days, as of 7 Aug its next charge was 8 Aug.

## FX — the silent-zero trap

Skio bills in ~59 currencies. An unconvertible subscription **does not fail — it
converts to zero**, producing a number that is wrong but entirely plausible (the
subscriber count is untouched, only the money moves).

This actually happened:

> On 25 Aug both FX providers went down mid-afternoon, the table degraded to the 18
> hardcoded fallbacks plus the 8 majors the daily sync persists, and the ~1,100 active
> subscriptions billing in AUD, CAD, HUF, ILS and the rest of the tail were counted at
> zero — an observed €519k was overwritten with €431k.

The guard: `MAX_UNCOVERED_FX_SHARE = 0.01`. If more than 1% of subs lack a rate, the
derive **throws** rather than publishing. Preserve this behaviour in any new code.

## MRR movement bridge

Explains how the **ceiling** moved day to day. (It applies to the ceiling only — the
calendar and four-week framings have no bridge.)

```
ceiling_end = ceiling_start
            + gained_new + recovered_dunning
            − lost_cancelled − lost_dunning
            + residual
```

Each leg is valued as that subscriber's **full forward 30-day charge schedule**, not a
single charge — so `gained_new` is "how much MRR we bought today", which can exceed
the first-order revenue when the rebill is priced higher than the checkout. Losses are
valued at the *prior* day's snapshot, since the sub no longer has a schedule.

### The residual is not noise

It's the term that closes the identity, and it is a **real, recurring effect** for a
4-week billing book — not a rounding error to hide. It absorbs:

- **window roll** (charges entering and leaving the 30-day horizon)
- rebill dates advancing one day
- pauses and unpauses
- price, discount and shipping edits

A live day makes the scale clear:

| | 2026-09-02 |
|---|---|
| `netChange` | −€15,238 |
| `netFromCohorts` | −€6,108 |
| **`residual`** | **−€9,130** |

The residual was 60% of the move. **Never report `netChange` as churn** — decompose it
first, and if the residual dominates, say so.

## Churn & cancellation

- **Genuine voluntary cancel** = status `CANCELLED` with **no** `statusContext`.
- `statusContext = 'DUNNING'` = involuntary, payment failure driven. Different
  problem, different fix — never pool them.
- Skio overwrites `statusContext` in place, so **dunning is only observable live**.
  Historical dunning cannot be reconstructed; that's why there's a sync every 20 min.
- Cancel-flow sessions (V1/V2/V3) record whether the cancel was self-serve, agent-
  assisted, or had no session at all, plus `pathTaken` and saves/abandons.

Retention/survival by cycle (cashflow model):

```
73.7% → 44.4% → 50.6% → 62.5% → 77.6% → tail 65%
```

Lifetime multiple:

```typescript
let surv = 1, rebills = 0;
for (let k = 1; k <= maxCycles; k++) { surv *= rateAt(k); rebills += surv; }
multiple = 1 + rebills * rebillUplift;   // rebillUplift = 1.183
```

## Dunning metrics

> ⚠️ Use **`fresh_not_billed`**, NOT `subs_due`. The retry pool inflates `subs_due`
> massively — one day's event-based failed-payment count read **1,482** when the real
> number was **42**.
