import { Buffer } from "node:buffer";

import { env } from "../../core/env.js";

/**
 * Tiny typed client for the scandi-revolut-expenses HTTP API.
 *
 * Single bearer token, single base URL, single endpoint we care about
 * (`GET /v1/report`). Used by both the agent's Revolut tools (in this
 * folder) and the `revolut-daily-expenses` workflow.
 */
export type RevolutPeriodKind =
  | "today"
  | "yesterday"
  | "this-week"
  | "last-week"
  | "on"
  | "range";

export interface RevolutReportParams {
  /** `today` | `yesterday` | `this-week` | `last-week` | `on` | `range`. */
  period: RevolutPeriodKind;
  /** Required when `period=on`. `DD/MM/YYYY` or `YYYY-MM-DD`. */
  date?: string;
  /** Required when `period=range`. */
  from?: string;
  /** Optional `range` end (inclusive end-of-day). */
  to?: string;
  /** `json` | `csv` | `md` | `html`. Defaults to `json`. */
  format?: "json" | "csv" | "md" | "html";
  /** `format=html` requires `smart=true`. */
  smart?: boolean;
  /** Filters. */
  account?: string;
  type?: string;
  currency?: string;
  include_pending?: boolean;
}

export interface RevolutReportResponse {
  /** Raw response body. */
  bytes: Buffer;
  /** Resolved `Content-Type` header. */
  mimeType: string;
  /** Number of transactions in the response (`X-Tx-Count`). null if absent. */
  txCount: number | null;
  /** Resolved human period label, e.g. `Yesterday (06/05/2026)`. */
  periodLabel: string | null;
  /** Filename suggested by `Content-Disposition`, if any. */
  fileName: string | null;
}

export interface RevolutClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Extra retries for transient network failures (not for 4xx/5xx). */
  retries?: number;
}

export class RevolutExpensesHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    // ASCII arrow — this string sometimes ends up in logs / JSON tool results;
    // keep it free of characters that have historically broken header paths.
    super(`RevolutExpenses ${endpoint} -> ${status}: ${message}`);
    this.name = "RevolutExpensesHttpError";
  }
}

export class RevolutExpensesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevolutExpensesValidationError";
  }
}

export interface RevolutExpensesClient {
  /** GET /health (public). Returns the health JSON. */
  health(): Promise<unknown>;
  /** GET /v1/report — fetch a report in any supported format. */
  report(
    params: RevolutReportParams,
    opts?: { signal?: AbortSignal },
  ): Promise<RevolutReportResponse>;
}

/** Accept ISO `YYYY-MM-DD` or European `DD/MM/YYYY` (also `.` / `-` separators). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EU_DATE_RE = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/;

/**
 * Normalise a user/LLM date into `YYYY-MM-DD` (preferred by the API) or throw.
 * Rejects nonsense like `32/13/2026` and bare timestamps with no calendar day.
 */
export function normalizeReportDate(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new RevolutExpensesValidationError(`${field} is empty.`);
  }
  if (ISO_DATE_RE.test(trimmed)) {
    assertValidYmd(trimmed, field);
    return trimmed;
  }
  const eu = EU_DATE_RE.exec(trimmed);
  if (eu) {
    const dd = Number(eu[1]);
    const mm = Number(eu[2]);
    const yyyy = Number(eu[3]);
    const iso = `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    assertValidYmd(iso, field);
    return iso;
  }
  throw new RevolutExpensesValidationError(
    `${field}='${raw}' is not a valid date. Use YYYY-MM-DD or DD/MM/YYYY.`,
  );
}

function assertValidYmd(iso: string, field: string): void {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) {
    throw new RevolutExpensesValidationError(`${field}='${iso}' is not a valid date.`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new RevolutExpensesValidationError(
      `${field}='${iso}' is not a real calendar day.`,
    );
  }
}

/**
 * Validate + normalise report params before they hit the wire. Throws
 * {@link RevolutExpensesValidationError} on bad input so tools can return a
 * clean `{ok:false}` instead of a confusing upstream 400/500.
 */
export function normalizeReportParams(
  params: RevolutReportParams,
): RevolutReportParams {
  const period = params.period;
  if (
    ![
      "today",
      "yesterday",
      "this-week",
      "last-week",
      "on",
      "range",
    ].includes(period)
  ) {
    throw new RevolutExpensesValidationError(
      `Unknown period '${String(period)}'. Use today|yesterday|this-week|last-week|on|range.`,
    );
  }

  const out: RevolutReportParams = { period };

  if (period === "on") {
    if (!params.date) {
      throw new RevolutExpensesValidationError(
        "period=on requires `date` (YYYY-MM-DD or DD/MM/YYYY).",
      );
    }
    out.date = normalizeReportDate(params.date, "date");
  }
  if (period === "range") {
    if (!params.from) {
      throw new RevolutExpensesValidationError(
        "period=range requires `from` (YYYY-MM-DD or DD/MM/YYYY).",
      );
    }
    out.from = normalizeReportDate(params.from, "from");
    if (params.to) {
      out.to = normalizeReportDate(params.to, "to");
      if (out.to < out.from) {
        throw new RevolutExpensesValidationError(
          `to (${out.to}) must be on or after from (${out.from}).`,
        );
      }
    }
  }

  const format = params.format ?? "json";
  if (!["json", "csv", "md", "html"].includes(format)) {
    throw new RevolutExpensesValidationError(
      `Unsupported format '${format}'. Use json|csv|md|html.`,
    );
  }
  out.format = format;

  const smart = params.smart ?? false;
  if (format === "html" && !smart) {
    throw new RevolutExpensesValidationError(
      "format=html requires smart=true.",
    );
  }
  out.smart = smart;

  if (params.account) out.account = params.account.trim();
  if (params.type) out.type = params.type.trim();
  if (params.currency) {
    const ccy = params.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) {
      throw new RevolutExpensesValidationError(
        `currency='${params.currency}' must be a 3-letter ISO 4217 code.`,
      );
    }
    out.currency = ccy;
  }
  if (params.include_pending !== undefined) {
    out.include_pending = Boolean(params.include_pending);
  }

  return out;
}

/** Parse Content-Disposition, preferring RFC 5987 `filename*`. */
export function parseContentDispositionFilename(
  header: string | null,
): string | null {
  if (!header) return null;
  const extended = header.match(/(?:^|;)\s*filename\*=UTF-8''([^;]*)/i);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1]);
    } catch {
      // fall through
    }
  }
  return header.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1]
    ?? header.match(/(?:^|;)\s*filename=([^;]+)/i)?.[1]?.trim()
    ?? null;
}

export function createRevolutExpensesClient(
  config?: Partial<RevolutClientConfig>,
): RevolutExpensesClient {
  const baseUrl = (config?.baseUrl ?? env.REVOLUT_EXPENSES_API_BASE_URL ?? "")
    .replace(/\/$/, "");
  const apiKey = config?.apiKey ?? env.REVOLUT_EXPENSES_API_KEY ?? "";
  // 60s — `smart=true` on a cold cache can take 30-60s for the LLM pass.
  const timeoutMs = config?.timeoutMs ?? 60_000;
  const retries = Math.max(0, config?.retries ?? 1);

  if (!baseUrl) throw new Error("REVOLUT_EXPENSES_API_BASE_URL is not set");
  if (!apiKey) throw new Error("REVOLUT_EXPENSES_API_KEY is not set");

  async function call(
    method: string,
    path: string,
    init: {
      query?: Record<string, string | number | boolean | undefined | null>;
      auth?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const search = init.query
      ? "?" +
        Object.entries(init.query)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          )
          .join("&")
      : "";
    const url = `${baseUrl}${path}${search}`;

    const headers: Record<string, string> = {};
    if (init.auth !== false) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ourCtl = new AbortController();
      const timer = setTimeout(
        () => ourCtl.abort(new Error("request timeout")),
        timeoutMs,
      );
      const signal = init.signal
        ? anySignal([init.signal, ourCtl.signal])
        : ourCtl.signal;

      try {
        const res = await fetch(url, { method, headers, signal });
        if (!res.ok) {
          const text = await readErrorBody(res);
          throw new RevolutExpensesHttpError(
            res.status,
            `${method} ${path}`,
            text || res.statusText,
          );
        }
        return res;
      } catch (err) {
        lastErr = err;
        // Never retry validation / HTTP errors / caller abort — only
        // transient network / timeout failures.
        if (
          err instanceof RevolutExpensesHttpError ||
          err instanceof RevolutExpensesValidationError ||
          init.signal?.aborted ||
          attempt >= retries
        ) {
          throw err;
        }
        await sleep(250 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return {
    async health() {
      const res = await call("GET", "/health", { auth: false });
      return res.json();
    },
    async report(params, opts) {
      const normalized = normalizeReportParams(params);
      const res = await call("GET", "/v1/report", {
        query: {
          period: normalized.period,
          date: normalized.date,
          from: normalized.from,
          to: normalized.to,
          format: normalized.format ?? "json",
          smart: normalized.smart ?? false,
          account: normalized.account,
          type: normalized.type,
          currency: normalized.currency,
          include_pending: normalized.include_pending,
        },
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const mimeType =
        res.headers.get("content-type") ?? "application/octet-stream";
      const txCountHeader = res.headers.get("x-tx-count");
      const periodLabel = res.headers.get("x-period");
      const fileName = parseContentDispositionFilename(
        res.headers.get("content-disposition"),
      );
      return {
        bytes,
        mimeType,
        txCount: txCountHeader ? Number.parseInt(txCountHeader, 10) : null,
        periodLabel,
        fileName,
      };
    },
  };
}

async function readErrorBody(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return "";
  try {
    const errJson = JSON.parse(raw) as {
      message?: string;
      error?: string;
    };
    return errJson.message ?? errJson.error ?? raw.slice(0, 500);
  } catch {
    return raw.slice(0, 500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      return ctl.signal;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}
