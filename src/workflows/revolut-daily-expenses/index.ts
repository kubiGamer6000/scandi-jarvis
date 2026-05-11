import { env } from "../../core/env.js";

import type { WorkflowDefinition } from "../types.js";

import { createRevolutExpensesClient } from "./client.js";

/**
 * Daily Revolut expenses report.
 *
 * Runs once per day (00:01 in Europe/Stockholm via systemd timer; see
 * `docs/DEPLOYMENT.md` §13). For each invocation:
 *
 *   1. Fetches yesterday's smart-mode HTML report from the
 *      scandi-revolut-expenses API.
 *   2. Sends a short text message to the configured chat ("expense report
 *      for today").
 *   3. Uploads the HTML as a `document` to the same chat, captioned with
 *      the period label the API returned (e.g. `Yesterday (06/05/2026)`).
 *
 * The whole thing is deterministic — no LLM in the loop. If the report API
 * is down we throw and the runner exits non-zero so systemd surfaces the
 * failure (and you'll see it in `jarvis workflow logs revolut-daily-expenses`).
 *
 * Destination chat resolution order:
 *   1. WORKFLOW_REVOLUT_CHAT_JID
 *   2. JARVIS_WORKFLOWS_DEFAULT_CHAT_JID
 *   3. (refuse to start)
 */
export const revolutDailyExpenses: WorkflowDefinition = {
  name: "revolut-daily-expenses",
  description:
    "Daily Revolut expenses report (yesterday, smart=true HTML) → WhatsApp chat.",
  async run(ctx) {
    const chatJid =
      env.WORKFLOW_REVOLUT_CHAT_JID ??
      env.JARVIS_WORKFLOWS_DEFAULT_CHAT_JID;
    if (!chatJid) {
      throw new Error(
        "WORKFLOW_REVOLUT_CHAT_JID or JARVIS_WORKFLOWS_DEFAULT_CHAT_JID must be set",
      );
    }

    const reports = createRevolutExpensesClient();

    ctx.log.info("fetching report", {
      api: env.REVOLUT_EXPENSES_API_BASE_URL,
      period: "yesterday",
      format: "html",
      smart: true,
    });

    const t0 = Date.now();
    const report = await reports.report(
      { period: "yesterday", format: "html", smart: true },
      { signal: ctx.signal },
    );
    ctx.log.info("report fetched", {
      bytes: report.bytes.byteLength,
      tx_count: report.txCount,
      period_label: report.periodLabel,
      ms: Date.now() - t0,
    });

    if (ctx.signal.aborted) throw new Error("aborted before WA send");

    // 1) Short text message — what the user actually sees in their feed.
    const sendRes = await ctx.wa.send(
      { to: chatJid, text: "expense report for today" },
      { signal: ctx.signal },
    );
    ctx.log.info("text sent", { chat_jid: chatJid, seq: sendRes.seq });

    if (ctx.signal.aborted) throw new Error("aborted before file send");

    // 2) The HTML as a downloadable document.
    const filename = pickFilename(report.fileName, report.periodLabel);
    const fileRes = await ctx.wa.sendMultipart(
      {
        to: chatJid,
        kind: "document",
        file: report.bytes,
        filename,
        mimetype: "text/html",
        caption: report.periodLabel ?? "Revolut expenses — yesterday",
      },
      { signal: ctx.signal },
    );
    ctx.log.info("file sent", {
      chat_jid: chatJid,
      seq: fileRes.seq,
      filename,
      size_bytes: report.bytes.byteLength,
    });
  },
};

function pickFilename(
  serverFilename: string | null,
  periodLabel: string | null,
): string {
  // Prefer whatever the API suggested via Content-Disposition. If absent or
  // weirdly empty, build one from the period label, falling back to a
  // timestamped fallback so two runs on the same day don't collide.
  if (serverFilename && /\.html?$/i.test(serverFilename)) {
    return serverFilename;
  }
  // Period label is "Yesterday (06/05/2026)" — extract the DD/MM/YYYY and
  // turn it into ISO so the filename sorts chronologically.
  const m = periodLabel?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `revolut-${yyyy}-${mm}-${dd}.html`;
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  return `revolut-yesterday-${stamp}.html`;
}
