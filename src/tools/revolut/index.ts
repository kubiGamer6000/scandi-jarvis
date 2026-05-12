import type { StructuredTool } from "@langchain/core/tools";

import type { WhatsappClient } from "../../apps/whatsapp/client.js";

import {
  createRevolutExpensesClient,
  type RevolutExpensesClient,
} from "./client.js";
import { createRevolutGetDataTool } from "./get-data.js";
import { createRevolutSendReportTool } from "./send-report.js";

export {
  createRevolutExpensesClient,
  RevolutExpensesHttpError,
  type RevolutExpensesClient,
  type RevolutReportParams,
  type RevolutReportResponse,
} from "./client.js";

export interface CreateRevolutToolsOptions {
  /**
   * Override the underlying HTTP client (useful for tests). Defaults to
   * `createRevolutExpensesClient()` which reads `REVOLUT_EXPENSES_API_BASE_URL`
   * + `REVOLUT_EXPENSES_API_KEY` from env.
   */
  client?: RevolutExpensesClient;
}

/**
 * Build the set of Revolut tools bound to a WhatsApp REST client.
 *
 * Two tools are returned:
 *
 *  - **`revolut_send_expense_report`** — generates a smart-mode HTML report
 *    for a given period and posts it to the current WhatsApp chat as a
 *    document attachment. WA-aware (reads `chatJid` from `runtime.context`).
 *    This is the default tool the agent should reach for when the user
 *    asks for a report.
 *
 *  - **`revolut_get_expense_data`** — fetches the raw JSON report data for
 *    a given period. Frontend-agnostic. Returns the structured data in the
 *    tool result; the agent reasons about it from there. Reserved for
 *    cases where the user explicitly asks for raw data or for analysis
 *    that needs the underlying figures.
 *
 * Both tools use `REVOLUT_EXPENSES_API_BASE_URL` + `REVOLUT_EXPENSES_API_KEY`
 * to talk to the `scandi-revolut-expenses` HTTP API. The factory throws at
 * construction time if either is missing — better a loud boot failure than
 * a silent first-call error.
 */
export function createRevolutTools(
  waClient: WhatsappClient,
  options: CreateRevolutToolsOptions = {},
): StructuredTool[] {
  const reports = options.client ?? createRevolutExpensesClient();
  return [
    createRevolutSendReportTool(waClient, reports),
    createRevolutGetDataTool(reports),
  ];
}

export type RevolutToolName =
  | "revolut_send_expense_report"
  | "revolut_get_expense_data";

export const REVOLUT_TOOL_NAMES: readonly RevolutToolName[] = [
  "revolut_send_expense_report",
  "revolut_get_expense_data",
];
