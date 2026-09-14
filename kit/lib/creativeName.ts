/**
 * The creative naming parser, ported from Editor Games.
 *
 * Five naming conventions exist in the wild, all encoding the same signals:
 *
 *   1. Pipe:          CRIS|1955|HOOK3|AI+UGC|...
 *   2. Dash:          DAVIDPLATA-1937-HOOK2-AI+UGC-FACT-MALE.mp4
 *   3. CPT short:     CPT-1887-CRIS-H3.mp4  (also CPT_1865_LAU_H2)
 *   4. No delimiter:  LAU1948HOOK3AITESTIMONIALPROBLEMSOLVEMEN032.mp4
 *   5. No hook token: CPT-1816-ZULU.mov  (pre-hook era, single variant)
 *
 * Strategy: do NOT parse positionally — the separators are too inconsistent.
 * Extract each signal with a targeted regex and group by the 4-digit concept
 * ID, which is the one invariant across every convention.
 */

/**
 * Date-shaped substrings are stripped FIRST. Otherwise a name like
 * "Scandi Gum 2026-06-30-0b471..." has 2026 read as a concept ID. Excluding
 * years by value will not work: concept IDs are already in the 1900s and will
 * grow into the 2000s.
 */
const DATE_LIKE =
  /\b\d{4}[-_/.]\d{1,2}[-_/.]\d{1,2}\b|\b\d{1,2}[-_/.]\d{1,2}[-_/.]\d{4}\b/g;

/** The editor roster. `onLeaderboard` controls whether they share the bonus pool. */
export interface Editor {
  name: string;
  tokens: string[];
  onLeaderboard: boolean;
}

/**
 * Seeded roster. In the live app an admin can edit these, so treat this as a
 * starting point and confirm against the Editor Games API for anything that
 * affects pay.
 */
export const DEFAULT_EDITORS: Editor[] = [
  { name: 'Cristian', tokens: ['CRIS'], onLeaderboard: true },
  { name: 'Adriian', tokens: ['ADRI'], onLeaderboard: true },
  { name: 'Laura', tokens: ['LAU'], onLeaderboard: true },
  { name: 'David', tokens: ['DAVIDPLATA', 'DAVID'], onLeaderboard: true },
  { name: 'Randolph', tokens: ['RANDOLPH'], onLeaderboard: true },
  { name: 'Sharon', tokens: ['SHARON'], onLeaderboard: true },
  { name: 'Zulu', tokens: ['ZULU'], onLeaderboard: false },
  { name: 'Mar', tokens: ['MAR'], onLeaderboard: false },
  { name: 'Javid', tokens: ['JAVID'], onLeaderboard: false },
  { name: 'Isaac', tokens: ['ISAAC'], onLeaderboard: false },
];

/**
 * Match a token on non-letter boundaries so JAVID never matches inside DAVID
 * and CLAUDIA never matches LAU.
 */
export function tokenMatches(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z])${escaped}([^A-Z]|$)`).test(haystack);
}

export interface ParsedCreativeName {
  editor: string | null;
  /** The 4-digit concept ID. The real grouping key. */
  conceptId: string | null;
  /** Hook variant number, as a string. "a video" means one of these. */
  hook: string | null;
  /** Iteration number, layered on top of a hook. */
  iteration: string | null;
  /** Spanish-language variant. */
  isSpanish: boolean;
}

/**
 * Extract editor, concept, hook, iteration and the Spanish flag.
 *
 * The full pipe form carries more — production type (AI, AI+UGC, MIX), angle
 * (PROBLEM SOLVE, FACT, TESTIMONIAL) and duration — but those are NOT parsed.
 * If someone asks to analyse by angle or production type, this is the function
 * that needs extending; don't pretend the data is already there.
 */
export function parseCreativeName(
  rawName: string | null | undefined,
  editors: Editor[] = DEFAULT_EDITORS,
): ParsedCreativeName {
  const empty: ParsedCreativeName = {
    editor: null,
    conceptId: null,
    hook: null,
    iteration: null,
    isSpanish: false,
  };
  if (!rawName) return empty;

  const name = rawName.toUpperCase();

  // Longest token first, so DAVIDPLATA always wins over DAVID.
  const candidates = editors
    .flatMap((editor) => editor.tokens.map((token) => ({ editor, token })))
    .sort((a, b) => b.token.length - a.token.length);
  const matched = candidates.find(({ token }) => tokenMatches(name, token));

  // First standalone 4-digit number, after dates are removed. Safe against
  // durations, which are either 3 digits (117, 032) or carry separators.
  const conceptMatch = /(?<!\d)(\d{4})(?!\d)/.exec(name.replace(DATE_LIKE, ' '));

  // HOOKn in any convention, or the short -Hn / _Hn form at a token boundary.
  const hookMatch = /HOOK\s*(\d)/.exec(name) ?? /[-_ ]H(\d)(?=[._\- ]|$)/.exec(name);
  const iterationMatch = /ITR\s*(\d)/.exec(name);

  return {
    editor: matched?.editor.name ?? null,
    conceptId: conceptMatch?.[1] ?? null,
    hook: hookMatch?.[1] ?? null,
    iteration: iterationMatch?.[1] ?? null,
    isSpanish: /(^|[^A-Z])ESP([^A-Z]|$)/.test(name),
  };
}

/**
 * The identity of a hook variant: one editor's take on one concept, with one
 * opening. This is the unit of analysis and the join key to the tracker.
 *
 * Concept IDs are NOT unique across editors, so both are required. A variant
 * that cannot name its owner or its concept cannot be matched with confidence,
 * hence the null.
 */
export function variantKeyOf(parsed: ParsedCreativeName): string | null {
  if (!parsed.editor || !parsed.conceptId) return null;
  return [parsed.editor, parsed.conceptId, parsed.hook ?? 'none', parsed.iteration ?? 'none'].join(
    '/',
  );
}

/**
 * Resolve the name to parse, in priority order. The convention lives in the
 * creative or file name; ad names usually mirror it. The first source that
 * identifies an editor wins.
 */
export function resolveCreativeName(sources: {
  creativeName?: string | null;
  videoTitle?: string | null;
  adName?: string | null;
}): { name: string | null; source: string; parsed: ParsedCreativeName } {
  const ordered: Array<[string, string | null | undefined]> = [
    ['creative name', sources.creativeName],
    ['video title', sources.videoTitle],
    ['ad name', sources.adName],
  ];

  for (const [source, value] of ordered) {
    if (!value) continue;
    const parsed = parseCreativeName(value);
    if (parsed.editor) return { name: value, source, parsed };
  }

  // Nothing named by convention. This is NORMAL — ad-copy names like
  // "🔥 40% OFF + Free Shipping" parse to no editor. Report unassigned volume
  // explicitly rather than silently dropping it; in one 30-day window it was
  // 8 videos, 132k impressions and €1.8k of spend.
  const fallback = sources.creativeName ?? sources.videoTitle ?? sources.adName ?? null;
  return { name: fallback, source: 'unassigned', parsed: parseCreativeName(fallback) };
}

/** Extract a Drive file ID from any of the link shapes smart chips produce. */
export function driveFileId(uri: string): string | null {
  return (
    /[?&]id=([\w-]+)/.exec(uri)?.[1] ??
    /\/(?:file|folder)\/d\/([\w-]+)/.exec(uri)?.[1] ??
    /\/d\/([\w-]+)/.exec(uri)?.[1] ??
    null
  );
}
