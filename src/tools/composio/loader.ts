import type { StructuredTool } from "@langchain/core/tools";

import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

import { getComposioClient, isComposioEnabled } from "./client.js";

const log = createLogger("tools/composio");

/**
 * Declarative description of which Composio tools an agent wants.
 *
 * Either pass `toolkits` (entire toolkits like "SHOPIFY") or `tools`
 * (specific slugs like "GITHUB_CREATE_ISSUE"), or both — they're additive.
 *
 * Toolkits often expose hundreds of tools, which can blow out the model's
 * context. Use `important: true` (the default) to load only Composio's
 * curated subset, and/or `limit` / `tags` to narrow further.
 */
export interface ComposioToolsConfig {
  /** Toolkit slugs (e.g. ["SHOPIFY", "GMAIL"]). */
  toolkits?: string[];
  /** Specific tool slugs (e.g. ["SHOPIFY_GET_PRODUCTS"]). */
  tools?: string[];
  /** Override the default user id from `COMPOSIO_USER_ID`. */
  userId?: string;
  /** Only fetch the toolkit's curated "important" tools. Default: true. */
  important?: boolean;
  /** Cap the number of tools returned per toolkit. Default: 50. */
  limit?: number;
  /** Optional tag filter (e.g. ["readonly"]). */
  tags?: string[];
}

/**
 * Cache of resolved tool collections, keyed by the canonicalised request.
 * Two agents asking for SHOPIFY with the same options will reuse the same
 * fetch within a single process.
 */
const cache = new Map<string, Promise<StructuredTool[]>>();

function cacheKey(userId: string, config: ComposioToolsConfig): string {
  return JSON.stringify({
    userId,
    toolkits: [...(config.toolkits ?? [])].sort(),
    tools: [...(config.tools ?? [])].sort(),
    important: config.important ?? true,
    limit: config.limit ?? 50,
    tags: [...(config.tags ?? [])].sort(),
  });
}

/**
 * Resolve a Composio tool spec into ready-to-use LangChain tools.
 *
 * Returns an empty array (with a warning) if `COMPOSIO_API_KEY` is not set,
 * so this function is safe to call from any agent regardless of the local
 * dev environment.
 */
export async function loadComposioTools(
  config: ComposioToolsConfig,
): Promise<StructuredTool[]> {
  const wantsToolkits = (config.toolkits?.length ?? 0) > 0;
  const wantsTools = (config.tools?.length ?? 0) > 0;
  if (!wantsToolkits && !wantsTools) return [];

  if (!isComposioEnabled()) {
    log.warn(
      "Composio toolkits requested but COMPOSIO_API_KEY is not set – skipping.",
      { toolkits: config.toolkits, tools: config.tools },
    );
    return [];
  }

  const userId = config.userId ?? env.COMPOSIO_USER_ID;
  const key = cacheKey(userId, config);
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = (async () => {
    const client = getComposioClient();
    const collected: StructuredTool[] = [];

    if (wantsToolkits) {
      const result = await client.tools.get(userId, {
        toolkits: config.toolkits!,
        important: config.important ?? true,
        limit: config.limit ?? 50,
        ...(config.tags?.length ? { tags: config.tags } : {}),
      });
      collected.push(...(result as unknown as StructuredTool[]));
    }

    if (wantsTools) {
      const result = await client.tools.get(userId, {
        tools: config.tools!,
      });
      collected.push(...(result as unknown as StructuredTool[]));
    }

    log.info("Loaded Composio tools", {
      toolkits: config.toolkits ?? [],
      tools: config.tools ?? [],
      userId,
      count: collected.length,
    });
    return collected;
  })();

  cache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    cache.delete(key);
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to load Composio tools", {
      message,
      toolkits: config.toolkits,
      tools: config.tools,
    });
    return [];
  }
}

/** Drop the in-process cache. Useful in tests or after re-auth. */
export function clearComposioCache(): void {
  cache.clear();
}
