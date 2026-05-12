import type { StructuredTool } from "@langchain/core/tools";

import { calculator } from "./math/calculator.js";
import { getCurrentDatetime } from "./time/current-datetime.js";
import { tavilyDeepResearch } from "./web/deep-research.js";
import { internetSearch } from "./web/internet-search.js";

/**
 * Single source of truth for every custom tool in the project.
 *
 * Adding a tool:
 *   1. Drop it into `src/tools/<domain>/<name>.ts` exporting a langchain `tool`.
 *   2. Import + add it to the `tools` map below using a stable string key.
 *   3. (optional) Reference it by key from any agent's `tools.ts` via
 *      `pickTools([...])`.
 *
 * Why a registry?
 *   - Makes the available tool surface visible in one place.
 *   - Lets agent definitions stay declarative (`["calculator", "internetSearch", "tavilyDeepResearch"]`).
 *   - Makes it trivial to expose the tool list to a UI / docs page later.
 */
export const tools = {
  calculator,
  getCurrentDatetime,
  internetSearch,
  tavilyDeepResearch,
} as const satisfies Record<string, StructuredTool>;

export type ToolName = keyof typeof tools;

/** Resolve a list of tool names to actual tool instances, in order. */
export function pickTools(names: readonly ToolName[]): StructuredTool[] {
  return names.map((name) => tools[name]);
}

/** Lightweight metadata for docs / UIs. */
export function listTools(): Array<{ name: ToolName; description: string }> {
  return (Object.keys(tools) as ToolName[]).map((name) => ({
    name,
    description: tools[name].description ?? "",
  }));
}
