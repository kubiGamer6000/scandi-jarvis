/**
 * Disk cache for API pulls, under workspace/cache/.
 *
 * The house rule is that analysis should never re-hit an API. Pull once, cache,
 * then iterate on the cached copy — it is faster, it keeps you inside rate
 * limits, and it means a re-run produces the same numbers you already reasoned
 * about.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { WORKSPACE_DIR } from './env.ts';

export const CACHE_DIR = resolve(WORKSPACE_DIR, 'cache');

function pathFor(key: string): string {
  // Keys are namespaced with slashes, e.g. "meta/insights-2026-08".
  const safe = key.replace(/[^a-zA-Z0-9._/-]/g, '_');
  return resolve(CACHE_DIR, `${safe}.json`);
}

export function readCache<T>(key: string, maxAgeMs?: number): T | null {
  const file = pathFor(key);
  if (!existsSync(file)) return null;
  if (maxAgeMs !== undefined && Date.now() - statSync(file).mtimeMs > maxAgeMs) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeCache(key: string, value: unknown): void {
  const file = pathFor(key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Run `fetcher` unless a fresh cached copy exists.
 *
 * `maxAgeMs` should reflect how fast the underlying data actually moves. Meta
 * restates conversions for ~72 hours, so caching yesterday's Meta numbers for
 * an hour is fine; caching them for a week is not.
 */
export async function cached<T>(
  key: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = readCache<T>(key, maxAgeMs);
  if (hit !== null) return hit;
  const fresh = await fetcher();
  writeCache(key, fresh);
  return fresh;
}
