import * as jarvis from "./jarvis/index.js";

/**
 * Registry of every agent in the project.
 *
 * Each entry exports both:
 *   - `definition` – static metadata (name, description, prompt, tools)
 *   - `build()`    – async factory returning a ready-to-invoke deep agent
 *
 * Adding a new agent:
 *   1. Create `src/agents/<name>/{index,prompt,tools}.ts`
 *   2. Import + add to the `agents` map below.
 */
export const agents = {
  jarvis,
} as const satisfies Record<
  string,
  { definition: { name: string; description: string }; build: () => Promise<unknown> }
>;

export type AgentKey = keyof typeof agents;

export function listAgents(): Array<{ key: AgentKey; name: string; description: string }> {
  return (Object.keys(agents) as AgentKey[]).map((key) => ({
    key,
    name: agents[key].definition.name,
    description: agents[key].definition.description,
  }));
}
