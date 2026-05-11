import type { SubAgentDefinition } from "../../core/agent.js";

import { SHOPIFY_SUBAGENT_PROMPT } from "./prompt.js";
import { SHOPIFY_COMPOSIO } from "./tools.js";

/**
 * Dedicated Shopify Admin GraphQL subagent.
 *
 * The main agent delegates Shopify work to this subagent via the `task` tool
 * so that:
 *   - the (often long) GraphQL request/response transcripts stay out of the
 *     main agent's context, and
 *   - one place owns the Shopify Admin API conventions (pagination, GIDs,
 *     userErrors, throttling, mutation footguns, etc.).
 *
 * The subagent returns a tight Markdown report — see `prompt.ts`.
 */
export const shopifySubagent: SubAgentDefinition = {
  name: "shopify-agent",
  description:
    "Dedicated Shopify Admin GraphQL specialist for Scandi Gum. Use this for ANY task that touches Shopify data — products, variants, inventory, orders, customers, fulfillments, draft orders, metafields, collections, etc. Pass a specific task and the exact shape of report you need back. Returns a structured Markdown report with summary, data, method, and caveats.",
  systemPrompt: SHOPIFY_SUBAGENT_PROMPT,
  composio: SHOPIFY_COMPOSIO,
  skillSets: ["shopify"],
};
