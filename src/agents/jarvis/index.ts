import { buildAgent, type AgentDefinition } from "../../core/agent.js";
import { shopifySubagent } from "../../subagents/shopify/index.js";

import { JARVIS_SYSTEM_PROMPT } from "./prompt.js";
import { jarvisTools } from "./tools.js";

/**
 * Declarative definition of the default Jarvis agent.
 *
 * Jarvis itself has *no* Shopify tools – every Shopify touchpoint is delegated
 * to the dedicated `shopify-agent` subagent (see `src/subagents/shopify/`).
 * That keeps the (often long) GraphQL transcripts and skill-script output out
 * of the main agent's context and centralises Shopify-specific conventions in
 * one place.
 */
export const definition: AgentDefinition = {
  name: "jarvis",
  description:
    "General-purpose Scandi Gum operations assistant. Plans, researches, calculates, and drafts. Delegates all Shopify work to the shopify-agent subagent.",
  systemPrompt: JARVIS_SYSTEM_PROMPT,
  tools: jarvisTools,
  /** Docx and other shared capabilities under `skills/jarvis/`. GP subagent inherits these. */
  skillSets: ["jarvis"],
  subagents: [shopifySubagent],
};

export async function build() {
  return buildAgent(definition);
}
