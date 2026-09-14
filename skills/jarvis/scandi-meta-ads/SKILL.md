---
name: scandi-meta-ads
description: Pulls and analyses Scandi Gum's Meta/Facebook ad performance at the individual ad and creative level, including hook variants, concepts, editors, video retention, hook rate, hold rate, CTR and ROAS. Use when the user asks which ads or creatives are performing, how a video or hook variant did, which editor's work is winning, video watch-through or drop-off, or wants creative performance broken down by concept, hook or editor. Also use for ad spend by campaign or ad set.
---

# Meta ads & creative performance

Two ad accounts, both EUR:

| Account | Name |
|---|---|
| `act_1954601172604872` | `0353 - P - PIN 1506 CC JAVID 01- Pinnacle` |
| `act_898439036348823` | `5289 - V3 - PIN 1506 JAVID CC 02 - Pinnacle` |

For **total ad spend and blended ROAS**, use `scandi-profit-api` — it resolves
Meta vs Triple Whale vs sheet precedence. Come here for **per-ad and
per-creative** questions, which the Profit API cannot answer.

```bash
# Creative leaderboard, grouped by hook variant
tsx /home/app/skills/jarvis/scandi-meta-ads/scripts/creatives.ts --days 14

# Group differently
tsx /home/app/skills/jarvis/scandi-meta-ads/scripts/creatives.ts --days 30 --by editor
tsx /home/app/skills/jarvis/scandi-meta-ads/scripts/creatives.ts --days 30 --by concept

# Raw daily ad rows, cached
tsx /home/app/skills/jarvis/scandi-meta-ads/scripts/creatives.ts --days 7 --by ad --csv /home/app/workspace/ads.csv
```

The pull is cached to `/home/app/workspace/cache/` — re-running with the same range does
not re-hit the API. Add `--refresh` to force a new pull.

## The vocabulary — get this right or the answer is wrong

| Term | Meaning |
|---|---|
| **Concept** | An idea, a 4-digit ID like `1906`. The real grouping key. |
| **Hook variant** | One editor's take on one concept, with one opening. `HOOK1`, `HOOK2`. |
| **Iteration** | A re-edit of a hook variant, `ITR1`, `ITR2`. |
| **Video** | ⚠️ **When the team says "a video" they mean a hook variant.** Not a file, not an ad. |
| **Ad** | A Meta ad. Many ads can carry the same hook variant — one ran across 57 ads in a month. |

**The hook variant is the unit of analysis**, identified by four signals:
`editor / concept / hook / iteration`. Concept IDs are **not unique across
editors**, so both are always required.

Naming conventions, parser regexes and the join to the creative tracker are in
`/home/app/kit/knowledge/06-creative-and-ad-structure.md`, and the parser itself is
`/home/app/kit/lib/creativeName.ts` — import it rather than re-deriving the regexes.

## Metric definitions used by the script

| Metric | Formula |
|---|---|
| Hook rate | 3-second plays / impressions |
| Hold rate | ThruPlays / 3-second plays |
| CTR | link clicks / impressions |
| ROAS | omni_purchase value / spend |
| Drop-off | 1 − (p100 / p25) |

## Four ways to get this wrong

**Sum `omni_purchase` only.** The `actions` array carries several aliases of
the same conversion — `omni_purchase`, `purchase`,
`offsite_conversion.fb_pixel_purchase`. **Adding them together multiplies
revenue several times over.** `omni_purchase` is Meta's unified event and the
one behind Ads Manager's `purchase_roas`.

**Never average per-day rates.** Meta will serve ready-made rates like
`inline_link_click_ctr`, but a rate that arrives per day cannot be
re-aggregated into a range, and the "unique" variants divide by **reach**,
which is not additive at all. Store numerators, divide at read time. The script
does this.

**Report unassigned volume explicitly.** Creatives named as ad copy rather than
by convention — `"🔥 40% OFF + Free Shipping"` — parse to no editor. In one
30-day window that was 8 videos, 132k impressions and €1.8k of spend. The
script prints an "unassigned" line; don't drop it silently.

**Meta numbers are provisional for ~72 hours.** Conversions get restated after
the fact. Anything pulled today for yesterday will change. Say so in any report
that will later be compared against.

## Retention fields

Meta reports exactly **six moments** in a play. There is **no 10% or 90%
field** — if asked for those, say they don't exist rather than interpolating.

| Signal | Source |
|---|---|
| 3-second plays | action type `video_view` inside `actions` — no dedicated field |
| ThruPlays | `video_thruplay_watched_actions` (complete, or 15s, whichever first) |
| 25/50/75/95/100% | `video_pNN_watched_actions`, single-entry arrays |

## Rate limiting

Meta's rate-limit budget **shrinks when you generate errors**, so a misbehaving
integration digs its own hole. `/home/app/kit/lib/meta.ts` handles it: 400ms pacing,
throttle headers read on every response with a stand-down above 80%
utilisation, retries only on the transient error codes, and a server-side
`ad.impressions > 0` filter so undelivered ads never travel. Healthy runs sit
at 2–8% utilisation.

`time_range` **only works on Insights** — it is not honoured by the `/ads`
edge. To pull ads by launch date, filter `created_time` and **verify
client-side**, because Meta may ignore the filter entirely.

## Auth

Handled by the credential gateway — no token is in the sandbox. Access is
read-only (GETs only). If a call fails with a gateway error, report the error
text to the user.
