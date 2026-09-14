/**
 * Shared retry and pacing helpers.
 *
 * Every retry policy in here exists because of a specific real failure, noted
 * at the point it applies. Please don't "simplify" them into one generic
 * policy — the APIs fail in genuinely different ways and want different waits.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Total attempts including the first. Six is the house default. */
  attempts?: number;
  /** Wait before attempt n (1-indexed). */
  delayFor?: (attempt: number) => number;
  /** Label used in the final error message. */
  label?: string;
  /** Return true to retry. Default: retry any thrown error. */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each wait, so long pulls can show progress. */
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
}

/** Exponential backoff, capped. Good for outages that persist for seconds. */
export const exponential = (capMs = 30_000) => (attempt: number) =>
  Math.min(1000 * 2 ** (attempt - 1), capMs);

/** Linear backoff. Good for leaky-bucket throttles that drain steadily. */
export const linear = (stepMs = 2000) => (attempt: number) => stepMs * attempt;

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 6,
    delayFor = exponential(),
    label = 'request',
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;
      const wait = delayFor(attempt);
      onRetry?.(attempt, error, wait);
      await sleep(wait);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attempts} attempts: ${detail}`);
}

/** Thrown for HTTP statuses so retry predicates can inspect the code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

export const isRetryableStatus = (error: unknown): boolean =>
  error instanceof HttpError ? error.status === 429 || error.status >= 500 : true;

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 60_000,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, url);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/**
 * Fixed-rate pacer. Meta's rate-limit budget shrinks when you generate errors,
 * so pacing is cheaper than recovering.
 */
export function pacer(minIntervalMs: number): () => Promise<void> {
  let last = 0;
  return async () => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}
