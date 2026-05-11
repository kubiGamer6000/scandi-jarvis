/**
 * End-to-end test that the shopify subagent picks up and follows the
 * `shopify-admin` skill correctly.
 *
 * Flow:
 *   1. Build jarvis (provisions Deno sandbox, syncs ./skills/ via middleware).
 *   2. Send a prompt that should make jarvis delegate to the shopify subagent.
 *   3. The subagent should: read SKILL.md → run search_docs.mjs → write a
 *      query → run validate.mjs → return a validated query.
 *   4. We dump the full message trace to a file and print a concise summary
 *      (every tool call + final answer) for inspection.
 *
 * Run:
 *   npx tsx scripts/test-skill-usage.ts
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { build as buildJarvis } from "../src/agents/jarvis/index.js";
import { closeSandbox } from "../src/core/sandbox.js";

const PROMPT =
  "Through your shopify subagent: write and validate a Shopify Admin " +
  "GraphQL query that fetches the 5 most recent orders with their id, name, " +
  "totalPriceSet, and customer email. Just return the validated query — do " +
  "NOT execute it against the store.";

type MaybeMessage = {
  _getType?: () => string;
  type?: string;
  name?: string;
  content?: unknown;
  tool_calls?: Array<{ name?: string; args?: unknown; id?: string }>;
  tool_call_id?: string;
};

function kindOf(m: MaybeMessage): string {
  return (m._getType?.() ?? m.type ?? "unknown") as string;
}

function preview(value: unknown, max = 240): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in (c as object)
            ? String((c as { text: unknown }).text ?? "")
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function main() {
  console.log("=".repeat(70));
  console.log("Building jarvis (provisioning sandbox, syncing skills)…");
  console.log("=".repeat(70));
  const t0 = Date.now();
  const agent = (await buildJarvis()) as {
    invoke: (
      input: { messages: Array<{ role: string; content: string }> },
      config: { configurable: { thread_id: string } },
    ) => Promise<{ messages: MaybeMessage[]; [k: string]: unknown }>;
  };
  console.log(`  built in ${Date.now() - t0}ms\n`);

  console.log("=".repeat(70));
  console.log("Prompt");
  console.log("=".repeat(70));
  console.log(PROMPT + "\n");

  console.log("=".repeat(70));
  console.log("Invoking jarvis…");
  console.log("=".repeat(70));
  const tInvoke = Date.now();
  const threadId = `skill-test-${randomUUID()}`;
  const result = await agent.invoke(
    { messages: [{ role: "user", content: PROMPT }] },
    { configurable: { thread_id: threadId } },
  );
  const elapsed = ((Date.now() - tInvoke) / 1000).toFixed(1);
  console.log(`  done in ${elapsed}s\n`);

  // Dump full state to disk for forensic inspection.
  const dumpPath = path.resolve("scripts/.skill-test-trace.json");
  await writeFile(dumpPath, JSON.stringify(result, null, 2));
  console.log(`  full state dumped → ${path.relative(process.cwd(), dumpPath)}\n`);

  console.log("=".repeat(70));
  console.log("Message trace");
  console.log("=".repeat(70));

  const messages = result.messages ?? [];
  let toolCallCount = 0;
  let executeCalls = 0;
  let taskCalls = 0;
  let sawSearchDocs = false;
  let sawValidate = false;

  for (const m of messages) {
    const kind = kindOf(m);
    if (kind === "human") {
      console.log(`\n[user] ${preview(textContent(m.content), 160)}`);
    } else if (kind === "ai" || kind === "AIMessage") {
      const text = textContent(m.content).trim();
      if (text) console.log(`\n[ai] ${preview(text, 300)}`);
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          toolCallCount++;
          const argStr = preview(tc.args, 220);
          console.log(`  [tool_call] ${tc.name}(${argStr})`);
          if (tc.name === "execute") {
            executeCalls++;
            const argText = JSON.stringify(tc.args ?? {});
            if (argText.includes("search_docs.mjs")) sawSearchDocs = true;
            if (argText.includes("validate.mjs")) sawValidate = true;
          }
          if (tc.name === "task") taskCalls++;
        }
      }
    } else if (kind === "tool" || kind === "ToolMessage") {
      const text = textContent(m.content);
      console.log(`  [tool_result name=${m.name ?? "?"}] ${preview(text, 240)}`);
    } else {
      console.log(`\n[${kind}] ${preview(m.content, 160)}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("Summary");
  console.log("=".repeat(70));
  console.log(`  total tool calls:        ${toolCallCount}`);
  console.log(`  task() calls (delegate): ${taskCalls}`);
  console.log(`  execute() calls:         ${executeCalls}`);
  console.log(`  saw search_docs.mjs:     ${sawSearchDocs ? "yes" : "no"}`);
  console.log(`  saw validate.mjs:        ${sawValidate ? "yes" : "no"}`);

  console.log("\nNOTE: subagent (shopify-agent) tool calls run inside a child");
  console.log("graph and may not appear above. Check its 'Method' section in");
  console.log("the final report below to see what scripts it ran.");

  console.log("\n" + "=".repeat(70));
  console.log("Final assistant reply");
  console.log("=".repeat(70));
  // Walk backwards for the last AI message with non-empty text.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (kindOf(m) === "ai" || kindOf(m) === "AIMessage") {
      const text = textContent(m.content);
      if (text.trim()) {
        console.log("\n" + text + "\n");
        break;
      }
    }
  }

  await closeSandbox();
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
