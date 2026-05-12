/**
 * Tiny terminal REPL for chatting with any registered Jarvis agent.
 *
 * Usage:
 *   npm run chat              # defaults to "jarvis"
 *   npm run chat -- jarvis    # explicit agent
 *   tsx src/apps/cli.ts jarvis
 *
 * In-session commands:
 *   /reset    start a fresh thread (clears agent memory)
 *   /agents   list available agents
 *   /tools    list tools the current agent has
 *   /exit     quit
 */
import { randomUUID } from "node:crypto";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { agents, listAgents, type AgentKey } from "../agents/index.js";
import { hasCredential } from "../core/env.js";
import { createLogger } from "../core/logger.js";
import { closeSandbox, isSandboxConfigured } from "../core/sandbox.js";

const log = createLogger("apps/cli");

function pickAgentKey(arg: string | undefined): AgentKey {
  const fallback: AgentKey = "jarvis";
  if (!arg) return fallback;
  if (arg in agents) return arg as AgentKey;
  console.error(`Unknown agent "${arg}". Available: ${Object.keys(agents).join(", ")}`);
  process.exit(1);
}

function preflightChecks(): void {
  if (!hasCredential("ANTHROPIC_API_KEY")) {
    console.error(
      "❌  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.",
    );
    process.exit(1);
  }
  if (!hasCredential("TAVILY_API_KEY")) {
    console.warn(
      "⚠️   TAVILY_API_KEY not set – internet_search and tavily_deep_research will return an error if used.",
    );
  }
  if (!isSandboxConfigured()) {
    console.warn(
      "⚠️   DENO_DEPLOY_TOKEN not set – the agent has no `execute` (shell) tool, and skill scripts will be readable but not runnable.",
    );
  }
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "(no response)";
  }
  // Walk backwards looking for the most recent AI message with text content.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      | { _getType?: () => string; content?: unknown; type?: string }
      | undefined;
    if (!m) continue;
    const kind = (m._getType?.() ?? m.type) as string | undefined;
    if (kind !== "ai" && kind !== "AIMessage" && kind !== undefined) continue;
    const content = m.content;
    if (typeof content === "string" && content.trim().length > 0) {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((c) =>
          typeof c === "string"
            ? c
            : c && typeof c === "object" && "text" in c
              ? String((c as { text: unknown }).text ?? "")
              : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text.trim().length > 0) return text;
    }
  }
  return "(no response)";
}

async function main() {
  preflightChecks();

  const agentKey = pickAgentKey(process.argv[2]);
  const { definition, build } = agents[agentKey];

  console.log(`\n🤖  ${definition.name} – ${definition.description}`);
  console.log(`Type your message. Commands: /reset /agents /tools /exit\n`);

  log.info("Building agent…", { agent: agentKey });
  const agent = (await build()) as {
    invoke: (
      input: { messages: Array<{ role: string; content: string }> },
      config: { configurable: { thread_id: string } },
    ) => Promise<{ messages: unknown }>;
  };

  let threadId = `cli-${randomUUID()}`;
  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const userInput = (await rl.question("you ▸ ")).trim();
    if (!userInput) continue;

    if (userInput === "/exit" || userInput === "/quit") break;

    if (userInput === "/reset") {
      threadId = `cli-${randomUUID()}`;
      console.log(`(memory cleared – new thread ${threadId})\n`);
      continue;
    }

    if (userInput === "/agents") {
      for (const a of listAgents()) {
        console.log(`  - ${a.key.padEnd(12)} ${a.description}`);
      }
      console.log();
      continue;
    }

    if (userInput === "/tools") {
      for (const t of definition.tools) {
        console.log(`  - ${t.name.padEnd(22)} ${t.description ?? ""}`);
      }
      console.log();
      continue;
    }

    try {
      const start = Date.now();
      const result = await agent.invoke(
        { messages: [{ role: "user", content: userInput }] },
        { configurable: { thread_id: threadId } },
      );
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const reply = lastAssistantText(result.messages);
      console.log(`\n${definition.name} ▸ ${reply}\n   (${elapsed}s)\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n❌  agent error: ${message}\n`);
    }
  }

  rl.close();
  await closeSandbox();
  console.log("bye 👋");
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
