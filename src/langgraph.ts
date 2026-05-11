/**
 * Entrypoint for `langgraph dev` / LangGraph deployments.
 *
 * Each export here is an async factory that returns a compiled deep agent.
 * The LangGraph platform supplies its own checkpointer at runtime, so we build
 * each agent with `enableMemory: false` to avoid the
 *   "checkpointer: true cannot be used for root graphs"
 * error you'd otherwise get.
 *
 * Referenced from `langgraph.json`.
 */
import { buildAgent } from "./core/agent.js";
import { definition as jarvisDefinition } from "./agents/jarvis/index.js";

export async function jarvis() {
  return buildAgent({ ...jarvisDefinition, enableMemory: false });
}
