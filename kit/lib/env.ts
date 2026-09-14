/**
 * Configuration for the kit inside Jarvis's sandbox.
 *
 * Unlike the desktop kit, there are NO credentials here. Every API call goes
 * to the Jarvis kit gateway (KIT_GATEWAY_URL), which attaches the real keys
 * host-side and refuses writes. Import the clients (profitApi.ts, shopify.ts,
 * skio.ts, meta.ts, triplewhale.ts) rather than calling the gateway by hand.
 *
 * Paths default to the sandbox layout; KIT_HOME overrides them for testing
 * outside the sandbox.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOME = process.env.KIT_HOME ?? '/home/app';

export const KIT_ROOT = resolve(HOME, 'kit');
export const WORKSPACE_DIR = resolve(HOME, 'workspace');
export const OUTPUT_DIR = resolve(HOME, 'output');
export const KNOWLEDGE_DIR = resolve(KIT_ROOT, 'knowledge');

/** Store timezone. Every "day" boundary in Scandi data is this, not UTC. */
export const STORE_TIMEZONE = 'Europe/Stockholm';
/** The only store. Present as a parameter on most Profit API routes. */
export const DEFAULT_STORE_ID = 'scandi-eu';

export type Service = 'profit' | 'shopify' | 'skio' | 'meta' | 'triplewhale';

export interface Env {
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_API_VERSION: string;
  META_API_VERSION: string;
  META_AD_ACCOUNT_IDS: string;
}

/** Non-secret configuration the gateway passes into the sandbox. */
export function env(): Env {
  return {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN ?? '',
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION ?? '2026-01',
    META_API_VERSION: process.env.META_API_VERSION ?? 'v25.0',
    META_AD_ACCOUNT_IDS: process.env.META_AD_ACCOUNT_IDS ?? '',
  };
}

/**
 * Base URL and auth header for one service on the gateway. Throws a readable
 * error when the gateway isn't reachable from here or the service isn't set up.
 */
export function gateway(service: Service): { url: string; headers: Record<string, string> } {
  const base = process.env.KIT_GATEWAY_URL;
  const token = process.env.KIT_GATEWAY_TOKEN;
  if (!base || !token) {
    throw new Error(
      'Kit gateway is not available in this environment (KIT_GATEWAY_URL unset). ' +
        'Scandi data APIs can only be reached from Jarvis\'s local sandbox.',
    );
  }
  const available = (process.env.KIT_SERVICES ?? '').split(',').filter(Boolean);
  if (!available.includes(service)) {
    throw new Error(
      `The "${service}" API is not configured on this Jarvis (available: ${available.join(', ') || 'none'}).`,
    );
  }
  return { url: `${base}/${service}`, headers: { 'x-kit-token': token } };
}

/** Meta ad account ids, split and trimmed. Both live accounts by default. */
export function metaAdAccountIds(): string[] {
  return env()
    .META_AD_ACCOUNT_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a service is reachable through the gateway. */
export function has(service: Service): boolean {
  return (process.env.KIT_SERVICES ?? '').split(',').includes(service);
}

/** Read a knowledge file by name, e.g. readKnowledge('08-pitfalls.md'). */
export function readKnowledge(file: string): string {
  return readFileSync(resolve(KNOWLEDGE_DIR, file), 'utf8');
}
