import { tool } from "langchain";
import { z } from "zod";

import { createLogger } from "../../core/logger.js";

import {
  type RevolutExpensesClient,
  RevolutExpensesHttpError,
} from "./client.js";

const log = createLogger("tools/revolut/get-data");

const getDataSchema = z.object({
  period: z
    .enum(["today", "yesterday", "this-week", "last-week", "on", "range"])
    .describe(
      "Reporting window. Anchored to Europe/Stockholm. Use `on` for a specific calendar day (set `date`); use `range` for an arbitrary span (set `from` and optionally `to`).",
    ),
  date: z
    .string()
    .optional()
    .describe("Required when `period=on`. `DD/MM/YYYY` or `YYYY-MM-DD`."),
  from: z
    .string()
    .optional()
    .describe("Required when `period=range`. `DD/MM/YYYY` or `YYYY-MM-DD`."),
  to: z
    .string()
    .optional()
    .describe(
      "Optional when `period=range`. Defaults to today in the API if omitted.",
    ),
  smart: z
    .boolean()
    .optional()
    .describe(
      "If true, also include the LLM-categorised per-merchant breakdown (`smart_report` in the response). Slower (~30-60s on cold cache). Default false.",
    ),
  currency: z
    .string()
    .optional()
    .describe("Optional currency filter (ISO 4217 code, e.g. `EUR`, `SEK`)."),
  include_pending: z
    .boolean()
    .optional()
    .describe(
      "Include pending transactions (default false). Pending transactions can change before they settle.",
    ),
});

type GetDataInput = z.infer<typeof getDataSchema>;

function validatePeriod(input: GetDataInput): string | null {
  if (input.period === "on" && !input.date) {
    return "period=on requires `date` (DD/MM/YYYY or YYYY-MM-DD).";
  }
  if (input.period === "range" && !input.from) {
    return "period=range requires `from` (DD/MM/YYYY or YYYY-MM-DD).";
  }
  return null;
}

export function createRevolutGetDataTool(reports: RevolutExpensesClient) {
  return tool(
    async (input: GetDataInput, runtime) => {
      const validationError = validatePeriod(input);
      if (validationError) {
        return JSON.stringify({ ok: false, error: validationError });
      }

      const t0 = Date.now();
      try {
        const report = await reports.report(
          {
            period: input.period,
            ...(input.date ? { date: input.date } : {}),
            ...(input.from ? { from: input.from } : {}),
            ...(input.to ? { to: input.to } : {}),
            ...(input.currency ? { currency: input.currency } : {}),
            ...(input.include_pending !== undefined
              ? { include_pending: input.include_pending }
              : {}),
            format: "json",
            smart: input.smart ?? false,
          },
          { signal: runtime.signal },
        );

        // The API returns application/json for format=json; parse so the LLM
        // sees structured data instead of a stringified-string blob.
        let parsed: unknown;
        try {
          parsed = JSON.parse(report.bytes.toString("utf-8"));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return JSON.stringify({
            ok: false,
            error: `Could not parse JSON response: ${message}`,
          });
        }

        log.info("data fetched", {
          period: input.period,
          tx_count: report.txCount,
          period_label: report.periodLabel,
          smart: input.smart ?? false,
          bytes: report.bytes.byteLength,
          ms: Date.now() - t0,
        });

        return JSON.stringify({
          ok: true,
          period_label: report.periodLabel,
          tx_count: report.txCount,
          report: parsed,
        });
      } catch (err) {
        if (err instanceof RevolutExpensesHttpError) {
          log.warn("get-data HTTP error", {
            status: err.status,
            endpoint: err.endpoint,
            message: err.message,
          });
          return JSON.stringify({
            ok: false,
            error: err.message,
            status: err.status,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn("get-data failed", { period: input.period, error: message });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "revolut_get_expense_data",
      description:
        "Fetch raw structured Revolut Business expense data (JSON) for a given period. Returns totals per currency, top counterparties, accounts, recent transactions, and (optionally) the smart-categorised per-merchant breakdown. " +
        "USE THIS ONLY when the user explicitly asks for raw data, a specific number, or analysis you can't do without the underlying figures (e.g. 'what did we spend on Meta last week?', 'which day had the most transactions?'). " +
        "DO NOT use this as a stepping stone to send a report — `revolut_send_expense_report` already fetches and ships the report in one call. The user is paying token cost for whatever you pull through here, so be deliberate.",
      schema: getDataSchema,
    },
  );
}
