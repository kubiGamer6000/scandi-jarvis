import { pickTools, type ToolName } from "../../tools/registry.js";

/**
 * Tool selection for the default Jarvis agent.
 *
 * Keep this list small and intentional. Each tool the agent has makes its
 * decision-making slower and more error-prone, so only enable what's
 * genuinely useful for Jarvis' current responsibilities.
 */
export const JARVIS_TOOL_NAMES = [
  "getCurrentDatetime",
  "calculator",
  "internetSearch",
] as const satisfies readonly ToolName[];

export const jarvisTools = pickTools(JARVIS_TOOL_NAMES);
