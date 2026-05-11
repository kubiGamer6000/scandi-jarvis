/**
 * Connectivity check for Composio: lists every tool that would be loaded for
 * each toolkit slug passed on the command line.
 *
 * Usage:
 *   tsx scripts/composio-list.ts            # defaults to SHOPIFY
 *   tsx scripts/composio-list.ts SHOPIFY GMAIL
 *
 * Requires COMPOSIO_API_KEY in your .env. Useful when debugging which tools
 * the agent actually sees vs. what you expect.
 */
import { isComposioEnabled, loadComposioTools } from "../src/tools/composio/index.js";

if (!isComposioEnabled()) {
  console.error("❌  COMPOSIO_API_KEY is not set – nothing to do.");
  process.exit(1);
}

const toolkits = process.argv.slice(2);
if (toolkits.length === 0) toolkits.push("SHOPIFY");

for (const toolkit of toolkits) {
  console.log(`\n=== ${toolkit} ===`);
  const tools = await loadComposioTools({ toolkits: [toolkit], limit: 100 });
  if (tools.length === 0) {
    console.log("  (no tools returned)");
    continue;
  }
  for (const t of tools) {
    const desc =
      typeof t.description === "string"
        ? t.description.split("\n")[0]?.slice(0, 80) ?? ""
        : "";
    console.log(`  - ${t.name.padEnd(48)} ${desc}`);
  }
  console.log(`  (${tools.length} tool${tools.length === 1 ? "" : "s"})`);
}
