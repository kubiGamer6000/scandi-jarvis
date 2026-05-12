import { Buffer } from "node:buffer";

import { env } from "../../core/env.js";

/**
 * Tiny typed client for the scandi-revolut-expenses HTTP API.
 *
 * Single bearer token, single base URL, single endpoint we care about
 * (`GET /v1/report`). Used by both the agent's Revolut tools (in this
 * folder) and the `revolut-daily-expenses` workflow.
 */
export interface RevolutReportParams {
  /** `today` | `yesterday` | `this-week` | `last-week` | `on` | `range`. */
  period: "today" | "yesterday" | "this-week" | "last-week" | "on" | "range";
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
}

export class RevolutExpensesHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(`RevolutExpenses ${endpoint} → ${status}: ${message}`);
    this.name = "RevolutExpensesHttpError";
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

export function createRevolutExpensesClient(
  config?: Partial<RevolutClientConfig>,
): RevolutExpensesClient {
  const baseUrl = (config?.baseUrl ?? env.REVOLUT_EXPENSES_API_BASE_URL ?? "")
    .replace(/\/$/, "");
  const apiKey = config?.apiKey ?? env.REVOLUT_EXPENSES_API_KEY ?? "";
  // 60s — `smart=true` on a cold cache can take 30-60s for the LLM pass.
  const timeoutMs = config?.timeoutMs ?? 60_000;

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
          .filter(([, v]) => v !== undefined && v !== null)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          )
          .join("&")
      : "";
    const url = `${baseUrl}${path}${search}`;

    const ourCtl = new AbortController();
    const timer = setTimeout(
      () => ourCtl.abort(new Error("request timeout")),
      timeoutMs,
    );
    const signal = init.signal
      ? anySignal([init.signal, ourCtl.signal])
      : ourCtl.signal;

    const headers: Record<string, string> = {};
    if (init.auth !== false) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    let res: Response;
    try {
      res = await fetch(url, { method, headers, signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let text = "";
      try {
        const errJson = (await res.json()) as { message?: string; error?: string };
        text = errJson.message ?? errJson.error ?? "";
      } catch {
        text = await res.text().catch(() => "");
      }
      throw new RevolutExpensesHttpError(
        res.status,
        `${method} ${path}`,
        text || res.statusText,
      );
    }
    return res;
  }

  return {
    async health() {
      const res = await call("GET", "/health", { auth: false });
      return res.json();
    },
    async report(params, opts) {
      const res = await call("GET", "/v1/report", {
        query: {
          period: params.period,
          date: params.date,
          from: params.from,
          to: params.to,
          format: params.format ?? "json",
          smart: params.smart ?? false,
          account: params.account,
          type: params.type,
          currency: params.currency,
          include_pending: params.include_pending,
        },
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
      const txCountHeader = res.headers.get("x-tx-count");
      const periodLabel = res.headers.get("x-period");
      const disposition = res.headers.get("content-disposition");
      const match = disposition?.match(/filename="?([^";]+)"?/i);
      const fileName = match?.[1] ?? null;
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
