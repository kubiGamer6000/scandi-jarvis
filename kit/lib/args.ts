/**
 * Command line parsing for the skill scripts.
 *
 * The only interesting thing here is that unknown flags are a hard error.
 * An agent that guesses `--split-subscriptions` when the flag is `--split`
 * would otherwise get a confident, plausible, wrong answer with no indication
 * anything was ignored. Failing loudly with the list of valid flags turns that
 * silent wrong number into a one-line correction.
 */

export interface ArgSpec {
  /** Flags that take a value: --days 7 */
  value?: readonly string[];
  /** Flags that are on/off: --split */
  boolean?: readonly string[];
}

export interface Args {
  command: string;
  /** Positional arguments after the command. */
  rest: string[];
  flag(name: string): string | undefined;
  has(name: string): boolean;
  /** Inclusive date range from --from/--to, or --days N back from today. */
  range(defaultDays?: number): { from: string; to: string };
}

const DATE_FLAGS = ['from', 'to', 'days'] as const;
const COMMON_FLAGS = ['csv', 'json', 'out'] as const;

export function parseArgs(spec: ArgSpec = {}): Args {
  const argv = process.argv.slice(2);
  // Scripts without subcommands (creatives.ts) start straight with flags.
  // Without this, `--days 3` was read as the command and its value as a
  // positional, silently falling back to the default range.
  const command = argv[0] === undefined ? 'help' : argv[0].startsWith('--') ? '' : argv[0];

  const valueFlags = new Set<string>([...DATE_FLAGS, 'csv', 'out', ...(spec.value ?? [])]);
  const boolFlags = new Set<string>(['json', 'help', ...(spec.boolean ?? [])]);

  const rest: string[] = [];
  const unknown: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = command === '' ? 0 : 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      rest.push(token);
      continue;
    }
    // Accept --flag=value as well as --flag value.
    const eq = token.indexOf('=');
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();

    if (valueFlags.has(name)) {
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const next = inline ?? argv[++i];
      if (next === undefined) fail(`--${name} needs a value`, spec);
      values.set(name, next);
    } else if (boolFlags.has(name)) {
      flags.add(name);
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length > 0) {
    fail(`unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, spec);
  }

  const flag = (name: string) => values.get(name.toLowerCase());
  const has = (name: string) => flags.has(name.toLowerCase());

  return {
    command,
    rest,
    flag,
    has,
    range(defaultDays = 30) {
      const to = flag('to') ?? isoDay(0);
      const days = Number(flag('days') ?? defaultDays);
      if (!Number.isFinite(days) || days < 1) {
        fail(`--days must be a positive number, got "${flag('days')}"`, spec);
      }
      const from = flag('from') ?? isoDay(-(days - 1), to);
      for (const [label, date] of [['--from', from], ['--to', to]] as const) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${label} must be YYYY-MM-DD, got "${date}"`, spec);
      }
      if (from > to) fail(`--from (${from}) is after --to (${to})`, spec);
      return { from, to };
    },
  };
}

function fail(message: string, spec: ArgSpec): never {
  const valid = [...DATE_FLAGS, ...COMMON_FLAGS, ...(spec.value ?? []), ...(spec.boolean ?? [])];
  console.error(`\nError: ${message}`);
  console.error(`\nValid flags: ${valid.map((f) => `--${f}`).join(' ')}`);
  console.error('Run this script with no arguments to see the commands.\n');
  process.exit(2);
}

/** Day offset from `base` (default today) as YYYY-MM-DD. */
export function isoDay(offset = 0, base?: string): string {
  const start = base ? new Date(`${base}T12:00:00Z`) : new Date();
  return new Date(start.getTime() + offset * 864e5).toISOString().slice(0, 10);
}
