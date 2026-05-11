/**
 * Quick functional check of the custom tools (no LLM involved).
 * Run with: tsx scripts/test-tools.ts
 */
import { calculator } from "../src/tools/math/calculator.js";
import { getCurrentDatetime } from "../src/tools/time/current-datetime.js";

const cases: Array<{ name: string; out: string }> = [];

cases.push({
  name: "calculator: simple",
  out: await calculator.invoke({ expression: "(120 - 95) / 95 * 100" }),
});
cases.push({
  name: "calculator: powers + funcs",
  out: await calculator.invoke({ expression: "sqrt(2) ** 2 + log(e)" }),
});
cases.push({
  name: "calculator: bad input",
  out: await calculator.invoke({ expression: "1 + )" }),
});
cases.push({
  name: "datetime: UTC",
  out: await getCurrentDatetime.invoke({}),
});
cases.push({
  name: "datetime: bad tz",
  out: await getCurrentDatetime.invoke({ timezone: "Atlantis/AvalonZ" }),
});

for (const c of cases) {
  console.log(`\n• ${c.name}\n  → ${c.out}`);
}

console.log("\n✅ tool checks complete");
