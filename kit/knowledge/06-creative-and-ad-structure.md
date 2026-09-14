# Creative & Ad Structure

How Scandi's paid-social creative is organised. This is the vocabulary to use when
anyone asks about video performance, and the schema behind every creative question.

Source: `d:\scandi\scandi-editor-games` (the "Editor Games" dashboard).

## The core vocabulary

| Term | Meaning |
|---|---|
| **Concept** | An idea, identified by a **4-digit concept ID** (e.g. `1906`). The real grouping key. |
| **Hook variant** | One editor's take on one concept, with **one opening**. `HOOK1`, `HOOK2`… |
| **Iteration** | A re-edit of a hook variant, `ITR1`, `ITR2`. Layered on top of hooks. |
| **Video** | ⚠️ **When the team says "a video" they mean a hook variant.** Not a file, not an ad. |
| **Ad** | A Meta ad. Many ads can carry the same hook variant (one variant ran across 57 ads in one month). |
| **Creative** | Meta's ad creative object, which points at a video asset. |
| **Editor** | The person who made the video. Encoded in the name. |
| **Creative strategist** | Writes the concept. Currently **not** identifiable from the data. |

The hierarchy, from the top:

```
Concept (1906)
  └── Hook variant (HOOK2)          ← "a video"
        └── Iteration (ITR2)         ← optional
              └── many Meta ads      ← many-to-one
                    └── ad creative → video asset
```

**A hook variant is the unit of analysis.** The identity of one is four signals:

```typescript
// The identity of a hook variant: one editor's take on one concept, with one opening.
export function variantKeyOf(parsed): string | null {
  if (parsed.editorId === null || parsed.conceptId === null) return null;
  return [parsed.editorId, parsed.conceptId, parsed.hook ?? "none", parsed.iteration ?? "none"]
    .join("/");
}
```

> **Concept IDs are not unique across editors**, so editor + concept are both required.
> A variant that can't name its owner or its concept can't be matched with confidence.

## Naming conventions

There are **five conventions in the wild**, all encoding the same signals. Quoted
from the parser:

```
1. Pipe:          CRIS|1955|HOOK3|AI+UGC|...
2. Dash:          DAVIDPLATA-1937-HOOK2-AI+UGC-FACT-MALE.mp4
3. CPT short:     CPT-1887-CRIS-H3.mp4  (also CPT_1865_LAU_H2, "CPT - 1794 - LAU - H3")
4. No delimiter:  LAU1948HOOK3AITESTIMONIALPROBLEMSOLVEMEN032.mp4
5. No hook token: CPT-1816-ZULU.mov (pre-hook era, single variant)
```

The full pipe form carries more than the parser extracts:

```
CRIS | 1906 | HOOK2 | AI | PROBLEM SOLVE | MIX | 1:16 | .mp4
 │      │      │      │     │              │     │
 │      │      │      │     │              │     └─ duration
 │      │      │      │     │              └─ talent/gender (MIX, MALE, MEN…)
 │      │      │      │     └─ angle (PROBLEM SOLVE, FACT, TESTIMONIAL…)
 │      │      │      └─ production type (AI, AI+UGC, AI UGC+MIX, AI+ANIMATION, MIX)
 │      │      └─ hook variant
 │      └─ concept ID
 └─ editor token
```

Observed **angles**: `PROBLEM SOLVE`, `FACT`, `TESTIMONIAL`, and named ones like
`CAVITIES` in `CPT-1430-CAVITIES-LAU-H3`.
Observed **production types**: `AI`, `AI+UGC`, `AI UGC+MIX`, `AI+ANIMATION`, `MIX`.

> These trailing fields are **not currently parsed** — only editor, concept, hook,
> iteration and the Spanish flag are extracted. If you want to analyse by angle or
> production type, you'd have to extend the parser.

## The parser — how signals are extracted

> **Strategy: don't parse positionally — the separators are too inconsistent.**
> Extract each signal with a targeted regex and group by the 4-digit concept ID,
> which is the one invariant across every convention.

Verbatim regexes:

```typescript
// Strip date-shaped substrings FIRST, else a year is read as a concept ID
const DATE_LIKE = /\b\d{4}[-_/.]\d{1,2}[-_/.]\d{1,2}\b|\b\d{1,2}[-_/.]\d{1,2}[-_/.]\d{4}\b/g;

// First standalone 4-digit number. Safe against durations, which are either
// 3 digits (117, 032) or contain separators (0:38, 01.07).
const concept = /(?<!\d)(\d{4})(?!\d)/.exec(n.replace(DATE_LIKE, " "));

// HOOKn (any convention) or the short -Hn / _Hn form at a token boundary
const hook = /HOOK\s*(\d)/.exec(n) ?? /[-_ ]H(\d)(?=[._\- ]|$)/.exec(n);

const itr = /ITR\s*(\d)/.exec(n);
const langEsp = /(^|[^A-Z])ESP([^A-Z]|$)/.test(n);
```

Two subtleties worth preserving in any reimplementation:

1. **Date stripping must come first.** `Scandi Gum 2026-06-30-0b471...` would
   otherwise have `2026` read as a concept ID. Concept IDs are already in the 1900s
   and will grow into the 2000s, so excluding years by value won't work.
2. **Editor tokens match on non-letter boundaries, longest-first**, so `JAVID` never
   matches `DAVID` and `CLAUDIA` never matches `LAU`:

```typescript
function tokenMatches(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z])${escaped}([^A-Z]|$)`).test(haystack);
}
// Editors matched longest-token-first so DAVIDPLATA always wins over DAVID
```

## Where the name comes from

Names are checked in priority order — the first that identifies an editor wins:

```typescript
{ source: "creative name", value: creative?.name },
{ source: "video title",   value: creative?.object_story_spec?.video_data?.title },
{ source: "ad name",       value: adName },
```

> The naming convention lives in the **creative or file name**; ad names usually
> mirror it.

**Unassigned creatives are normal.** Anything named as ad copy rather than by
convention — `"Gum that actually repairs your teeth? 🧬🦷… 2026-07-02-20197aa2…"` or
`"🔥 40% OFF + Free Shipping"` — parses to no editor. In one 30-day window this was
8 videos, 132k impressions, €1.8k spend. **Report unassigned volume explicitly**
rather than silently dropping it.

## The two Meta ad accounts

| Account ID | Name |
|---|---|
| `act_898439036348823` | `5289 - V3 - PIN 1506 JAVID CC 02 - Pinnacle` |
| `act_1954601172604872` | `0353 - P - PIN 1506 CC JAVID 01- Pinnacle` |

Note both are named after **Javid** and "Pinnacle". `act_1954601172604872` is the one
the profit sheet's historical Facebook columns came from.

## How a creative gets identified, end to end

1. Pull daily insights → collect unique `ad_id`s
2. Batch-fetch ads (50 IDs per call) with the creative nested
3. Resolve the video key: **first Meta video ID found, else `name:{UPPERCASE_NAME}`**
4. Resolve the name in priority order: creative name → video title → ad name
5. `parseCreativeName()` → editor, concept, hook, iteration
6. `variantKeyOf()` → the join key to the tracker

The `name:` fallback matters — it keeps ads addressable when Meta exposes no video
asset. Non-video ads get a null video key and are excluded by an `is_video` flag.

## Joining Meta to the creative tracker

A second source — the team's **creative tracker spreadsheet** — supplies what Meta
cannot: **when a creative was first tested**, and a **Drive link to the file**.

> The two sides are joined on **editor, concept, hook and iteration** — the four
> signals both a file name and an ad name carry — so a spreadsheet row and a Meta ad
> meet at the level of one hook variant.

The tracker lives on a tab named **`Creatives`**. Columns are located by header text,
not position — the creative column matches `drive link`, `creative` or `file`. Other
columns cover Facebook/TikTok status, organic TT/IG, description and date tested.
Column A is a row-added timestamp with no header, read positionally.

Drive links arrive as **smart chips**, and the file ID is extracted with:

```typescript
export function driveFileId(uri: string): string | null {
  return (
    /[?&]id=([\w-]+)/.exec(uri)?.[1] ??
    /\/(?:file|folder)\/d\/([\w-]+)/.exec(uri)?.[1] ??
    /\/d\/([\w-]+)/.exec(uri)?.[1] ??
    null
  );
}
```

Practical notes:

- The tracker is reconciled **keyed by Drive file ID, not row number**, because the
  sheet is re-sorted constantly and a row's position is not its identity.
- Duplicate Drive files are collapsed by preference: **non-cancelled wins, then
  earliest test date**.
- Clip lengths come from Drive and are **cached forever** — creatives are shared with
  the service account individually, so Drive won't list them in bulk and each length
  costs its own request.
- **Launch dates only exist for creatives someone logged.** Anything not in the
  tracker cannot appear in launch-date-dependent views.

## Deduplication

One hook variant can span many files and many ads. When aggregating, group by the
variant identity, not by ad or by video ID. In one 30-day window: **661 ads
delivered impressions, deduping to 317 unique video creatives**, which then group
into far fewer hook variants.

Non-video ads exist and are **excluded** from creative analysis (8 ads, 170k
impressions, €2.6k spend in that same window). Classify with:

```typescript
export function isVideoCreative(creative): boolean {
  return creative?.object_type === "VIDEO" || videoIdsOf(creative).length > 0;
}

export function videoIdsOf(creative): string[] {
  return [
    creative?.video_id,
    creative?.object_story_spec?.video_data?.video_id,
    ...(creative?.asset_feed_spec?.videos ?? []).map((v) => v.video_id),
  ].filter(Boolean);
}
```
