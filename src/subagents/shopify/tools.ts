import type { ComposioToolsConfig } from "../../tools/composio/index.js";

/**
 * Composio tools the Shopify subagent has access to.
 *
 * Currently a single, very flexible tool: the Shopify Admin GraphQL executor.
 * Add more slugs here (e.g. specific REST helpers) only when the GraphQL tool
 * genuinely can't do the job — extra tools cost context with no upside.
 */
export const SHOPIFY_COMPOSIO: ComposioToolsConfig = {
  tools: ["SHOPIFY_GRAPH_QL_QUERY"],
};
