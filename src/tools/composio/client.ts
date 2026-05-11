import { Composio } from "@composio/core";
import { LangchainProvider } from "@composio/langchain";

import { env, hasCredential } from "../../core/env.js";

/**
 * Lazy, process-wide singleton Composio client.
 *
 * We construct it on first use so that:
 *   - merely importing this module never fails when COMPOSIO_API_KEY is unset
 *     (callers should check `isComposioEnabled()` first), and
 *   - we share a single HTTP client / auth context across every agent.
 *
 * The client is wired with the LangchainProvider, so `composio.tools.get(...)`
 * returns LangChain `DynamicStructuredTool` instances ready to drop into a
 * deepagents `tools` array.
 */
let cachedClient: Composio<LangchainProvider> | null = null;

export function isComposioEnabled(): boolean {
  return hasCredential("COMPOSIO_API_KEY");
}

export function getComposioClient(): Composio<LangchainProvider> {
  if (!isComposioEnabled()) {
    throw new Error(
      "Composio is not configured. Set COMPOSIO_API_KEY in your .env file.",
    );
  }
  if (!cachedClient) {
    cachedClient = new Composio({
      apiKey: env.COMPOSIO_API_KEY,
      provider: new LangchainProvider(),
    });
  }
  return cachedClient;
}
