import { tool } from "langchain";
import { TavilySearch } from "@langchain/tavily";
import { z } from "zod";

import { env, hasCredential } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("tools/internet-search");

/**
 * General-purpose web search backed by Tavily.
 *
 * - Designed for the agent to use when it needs fresh / external information.
 * - Falls back to a clear error message if `TAVILY_API_KEY` isn't configured,
 *   so the tool can be safely registered even on machines without the key.
 */
export const internetSearch = tool(
  async ({
    query,
    maxResults = 5,
    topic = "general",
    includeRawContent = false,
  }: {
    query: string;
    maxResults?: number;
    topic?: "general" | "news" | "finance";
    includeRawContent?: boolean;
  }) => {
    if (!hasCredential("TAVILY_API_KEY")) {
      log.warn("internet_search called but TAVILY_API_KEY is not set");
      return JSON.stringify({
        ok: false,
        error:
          "Web search is unavailable: TAVILY_API_KEY is not configured. Tell the user the operator must add this credential to enable web search.",
      });
    }

    const tavily = new TavilySearch({
      maxResults,
      tavilyApiKey: env.TAVILY_API_KEY,
      includeRawContent,
      topic,
    });

    try {
      return await tavily.invoke({ query });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Tavily search failed", { message });
      return JSON.stringify({ ok: false, error: message });
    }
  },
  {
    name: "internet_search",
    description:
      "Run a web search via Tavily. Use for fresh / external information you don't already have. Avoid for math or anything available through other tools.",
    schema: z.object({
      query: z.string().min(1).describe("The search query."),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Maximum number of results to return (1-20)."),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general")
        .describe(
          "Search topic. Use 'news' for current events, 'finance' for markets, 'general' otherwise.",
        ),
      includeRawContent: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include raw page content in the result. Costs more tokens, only use when summaries aren't enough.",
        ),
    }),
  },
);
