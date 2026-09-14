import { buildAgent, type AgentDefinition } from "../../core/agent.js";

import { JARVIS_SYSTEM_PROMPT } from "./prompt.js";
import { jarvisTools } from "./tools.js";

/**
 * Declarative definition of the default Jarvis agent.
 *
 * Business data (Profit API, Shopify, Skio, Meta) comes from the Scandi skills
 * in `skills/jarvis/`, which run kit scripts in the sandbox through the
 * credential gateway. Heavy multi-step analysis goes to the built-in
 * `general-purpose` subagent, which inherits the same skills.
 */
export const definition: AgentDefinition = {
  name: "jarvis",
  description:
    "Scandi Gum operations assistant: live profit, MRR, Shopify, Skio and Meta numbers, research, documents and decks.",
  systemPrompt: JARVIS_SYSTEM_PROMPT,
  tools: jarvisTools,
  /** Docx and other shared capabilities under `skills/jarvis/`. GP subagent inherits these. */
  skillSets: ["jarvis"],
};

export async function build() {
  return buildAgent(definition);
}
