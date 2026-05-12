import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredTool } from "@langchain/core/tools";

import { definition as jarvisDef } from "../../agents/jarvis/index.js";
import { buildAgent } from "../../core/agent.js";
import { env } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";
import { getSandbox, isSandboxConfigured } from "../../core/sandbox.js";
import { createWhatsappRateLimitMiddleware } from "../../core/wa-rate-limit.js";
import { createRevolutTools } from "../../tools/revolut/index.js";
import { createWhatsappTools, WhatsappContextSchema } from "../../tools/whatsapp/index.js";

import type { WhatsappClient } from "./client.js";

const log = createLogger("apps/whatsapp/agent");

export interface BuildWhatsappAgentOptions {
  client: WhatsappClient;
  /**
   * Postgres-backed checkpointer for per-chat thread persistence. The WA
   * server constructs this with `PostgresSaver.fromConnString(SUPABASE_DB_URL)`
   * and calls `.setup()` once at boot.
   */
  checkpointer: BaseCheckpointSaver;
}

/**
 * Build a Jarvis variant wired for the WhatsApp frontend:
 *   - Adds the 8 WhatsApp tools, each bound to the supplied REST client.
 *   - Declares `contextSchema = WhatsappContextSchema` so tools can pull
 *     `chatJid`/`triggeringSeq` from `runtime.context`.
 *   - Replaces the in-memory MemorySaver with the Postgres checkpointer so
 *     thread state persists across deploys.
 *
 * Everything else (system prompt, subagents, skills) is shared with the CLI
 * Jarvis. The runner stitches in per-run context as a HumanMessage prefix.
 */
export async function buildWhatsappAgent(opts: BuildWhatsappAgentOptions) {
  // Share the agent's Deno sandbox (when configured) with the WA file tools so
  // that `whatsapp_pull_file` writes land where `write_file` / `execute` see
  // them, and `whatsapp_send_file` reads files the agent just wrote via the
  // shell (`execute mkdir -p … && cat > /home/app/wa-out/…`). Without this
  // they default to a separate StateBackend and the agent's sandbox-written
  // files look "not found" to the uploader.
  const sandbox = isSandboxConfigured() ? await getSandbox() : null;
  const waTools = createWhatsappTools(opts.client, sandbox ? { backend: sandbox } : {});

  // Revolut tools are opt-in: they need both env vars to point at the
  // scandi-revolut-expenses HTTP API. If either is missing we skip them
  // entirely (the agent prompt mentions them only because we wire them
  // here — without registration they'd just be dead text).
  const revolutEnabled = Boolean(
    env.REVOLUT_EXPENSES_API_BASE_URL && env.REVOLUT_EXPENSES_API_KEY,
  );
  const revolutTools = revolutEnabled ? createRevolutTools(opts.client) : [];

  log.info("Building WhatsApp Jarvis", {
    waTools: waTools.map((t: StructuredTool) => t.name),
    revolutTools: revolutTools.map((t: StructuredTool) => t.name),
    baseTools: jarvisDef.tools.map((t) => t.name),
    file_backend: sandbox ? `deno:${sandbox.id}` : "state",
    revolut_enabled: revolutEnabled,
  });

  const rateLimit = createWhatsappRateLimitMiddleware();

  const agent = await buildAgent({
    ...jarvisDef,
    name: "jarvis-whatsapp",
    tools: [...jarvisDef.tools, ...waTools, ...revolutTools],
    contextSchema: WhatsappContextSchema,
    enableMemory: opts.checkpointer,
    extraMiddleware: [rateLimit],
  });
  return agent;
}

export type WhatsappAgent = Awaited<ReturnType<typeof buildWhatsappAgent>>;
