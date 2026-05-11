/**
 * Smoke test: builds every registered agent and prints its tool surface.
 * Does NOT call the LLM, so it works without a real ANTHROPIC_API_KEY.
 *
 * Run with: tsx scripts/smoke-test.ts
 */
import { agents, listAgents } from "../src/agents/index.js";

console.log("Registered agents:");
for (const a of listAgents()) {
  console.log(`  - ${a.key}: ${a.description}`);
}

for (const [key, mod] of Object.entries(agents)) {
  const built = await mod.build();
  const def = mod.definition;
  console.log(
    `\nBuilt "${key}" – tools: [${def.tools.map((t) => t.name).join(", ")}]`,
  );
  console.log(
    `  invoke=${typeof (built as { invoke?: unknown }).invoke}, stream=${typeof (built as { stream?: unknown }).stream}`,
  );
}

console.log("\n✅ smoke test passed");
