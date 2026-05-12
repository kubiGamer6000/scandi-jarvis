import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import type { WhatsappClient } from "../../apps/whatsapp/client.js";
import { createLogger } from "../../core/logger.js";
import {
  readWhatsappContext,
  type WhatsappContext,
} from "../whatsapp/runtime-context.js";

import {
  type RevolutExpensesClient,
  RevolutExpensesHttpError,
} from "./client.js";

const log = createLogger("tools/revolut/send-report");

/**
 * Period schema mirrors the API's `?period=` parameter so the LLM only ever
 * has to pick from a fixed enum. Validation for the conditional `date` /
 * `from` fields happens in the tool body (Zod's discriminated unions get
 * awkward in tool schemas — Anthropic sometimes sends them with the wrong
 * tag). We keep the schema flat and produce friendly error messages.
 */
const periodSchema = z.object({
  period: z
    .enum(["today", "yesterday", "this-week", "last-week", "on", "range"])
    .describe(
      "Reporting window. Anchored to Europe/Stockholm wall-clock. " +
        "Use `on` for a specific calendar day (then set `date`). " +
        "Use `range` for an arbitrary span (then set `from` and optionally `to`).",
    ),
  date: z
    .string()
    .optional()
    .describe(
      "Required when `period=on`. `DD/MM/YYYY` or `YYYY-MM-DD` (Stockholm date).",
    ),
  from: z
    .string()
    .optional()
    .describe(
      "Required when `period=range`. Inclusive start date in `DD/MM/YYYY` or `YYYY-MM-DD`.",
    ),
  to: z
    .string()
    .optional()
    .describe(
      "Optional when `period=range`. Inclusive end date. Defaults to today if omitted.",
    ),
});

const sendReportSchema = periodSchema.extend({
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe(
      "Optional caption shown beneath the document in WhatsApp. " +
        "Defaults to the period label the API returned (e.g. `Yesterday (06/05/2026)`).",
    ),
});

type SendReportInput = z.infer<typeof sendReportSchema>;

function validatePeriod(input: SendReportInput): string | null {
  if (input.period === "on" && !input.date) {
    return "period=on requires `date` (DD/MM/YYYY or YYYY-MM-DD).";
  }
  if (input.period === "range" && !input.from) {
    return "period=range requires `from` (DD/MM/YYYY or YYYY-MM-DD).";
  }
  return null;
}

export function createRevolutSendReportTool(
  waClient: WhatsappClient,
  reports: RevolutExpensesClient,
) {
  return tool(
    async (
      input: SendReportInput,
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
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
            format: "html",
            // HTML output server-side requires smart=true; the LLM-categorised
            // pass produces the per-merchant tables.
            smart: true,
          },
          { signal: runtime.signal },
        );

        log.info("report fetched", {
          chat_jid: ctx.chatJid,
          period: input.period,
          tx_count: report.txCount,
          period_label: report.periodLabel,
          bytes: report.bytes.byteLength,
          ms: Date.now() - t0,
        });

        if (runtime.signal?.aborted) {
          return JSON.stringify({ ok: false, error: "aborted before WA send" });
        }

        const filename = pickFilename(report.fileName, report.periodLabel);
        const caption =
          input.caption ??
          report.periodLabel ??
          captionFromPeriod(input);

        const sent = await waClient.sendMultipart(
          {
            to: ctx.chatJid,
            kind: "document",
            file: report.bytes,
            filename,
            mimetype: "text/html",
            caption,
          },
          { signal: runtime.signal },
        );

        log.info("report sent", {
          chat_jid: ctx.chatJid,
          period: input.period,
          seq: sent.seq,
          filename,
          size_bytes: report.bytes.byteLength,
        });

        return JSON.stringify({
          ok: true,
          period_label: report.periodLabel,
          tx_count: report.txCount,
          filename,
          file_size_bytes: report.bytes.byteLength,
          seq: sent.seq,
          wa_message_id: sent.wa_message_id,
        });
      } catch (err) {
        if (err instanceof RevolutExpensesHttpError) {
          log.warn("report HTTP error", {
            chat_jid: ctx.chatJid,
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
        log.warn("send-report failed", {
          chat_jid: ctx.chatJid,
          period: input.period,
          error: message,
        });
        return JSON.stringify({ ok: false, error: message });
      }
    },
    {
      name: "revolut_send_expense_report",
      description:
        "Generate a Revolut Business expense report for a given period and send it to the current WhatsApp chat as an HTML document attachment. " +
        "Uses smart categorisation (LLM-grouped per merchant) — the file opens to a clean, self-contained styled report. " +
        "Period is anchored to Europe/Stockholm. Returns a confirmation with the period label, transaction count, and the seq of the sent message. " +
        "USE THIS for any 'show me / send / generate the expenses report' request. Do NOT first call `revolut_get_expense_data` and then this — this tool already fetches + sends in one shot. " +
        "Smart-mode HTML can take ~30-60s on a cold cache; consider sending a `⏳` reaction first.",
      schema: sendReportSchema,
    },
  );
}

// ---------- helpers ----------

function pickFilename(
  serverFilename: string | null,
  periodLabel: string | null,
): string {
  if (serverFilename && /\.html?$/i.test(serverFilename)) {
    return serverFilename;
  }
  // Period label is e.g. "Yesterday (06/05/2026)" or "Last week (28/04 – 04/05/2026)".
  // Prefer the first DD/MM/YYYY we find for a sortable filename.
  const m = periodLabel?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `revolut-${yyyy}-${mm}-${dd}.html`;
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  return `revolut-${stamp}.html`;
}

function captionFromPeriod(input: SendReportInput): string {
  switch (input.period) {
    case "today":
      return "Revolut expenses — today";
    case "yesterday":
      return "Revolut expenses — yesterday";
    case "this-week":
      return "Revolut expenses — this week";
    case "last-week":
      return "Revolut expenses — last week";
    case "on":
      return `Revolut expenses — ${input.date}`;
    case "range":
      return input.to
        ? `Revolut expenses — ${input.from} to ${input.to}`
        : `Revolut expenses — from ${input.from}`;
  }
}
