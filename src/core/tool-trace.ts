import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

import { createLogger } from "./logger.js";

const log = createLogger("core/tool-trace");

/**
 * Maximum characters of the tool input/output to log inline. Long blobs
 * (file dumps, big GraphQL responses) are truncated with `…` so logs stay
 * readable.
 */
const TRACE_TRUNCATE = 600;

function trunc(s: string, n: number = TRACE_TRUNCATE): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}… [${s.length - n} more chars]`;
}

function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * LangChain callback handler that logs every tool call + result happening
 * inside an agent run — including tools called from subagents (e.g. Shopify
 * Composio tools) that don't log via our own scoped logger.
 *
 * Wire it into an invoke/stream by passing `{ callbacks: [createToolTracer()] }`
 * in the run config. Each tool call produces:
 *
 *   INFO core/tool-trace tool → <name> {"input":"…","tags":[…]}
 *   INFO core/tool-trace tool ← <name> {"output":"…","ms":NNN}
 *
 * Errors thrown by a tool surface as:
 *
 *   WARN core/tool-trace tool ✖ <name> {"error":"…","ms":NNN}
 *
 * `extraMeta` is mixed into every line — pass `chat_jid` from the WA runner
 * so multiple concurrent chats are trivially greppable.
 */
export function createToolTracer(extraMeta: Record<string, unknown> = {}) {
  const starts = new Map<string, number>();
  const names = new Map<string, string>();

  return new (class extends BaseCallbackHandler {
    name = "ToolTraceHandler";

    handleToolStart(
      tool: { name?: string; id?: string[] } | Record<string, unknown>,
      input: string,
      runId: string,
      _parentRunId?: string,
      tags?: string[],
      _metadata?: Record<string, unknown>,
      runName?: string,
    ): void {
      starts.set(runId, Date.now());
      // LangChain populates the tool identity in (roughly) priority order:
      //   1. `runName` (the human-readable tool name, e.g. "whatsapp_send_file")
      //   2. `serialized.name` (older shape)
      //   3. `serialized.id[]` — last segment is the class name
      //      (DynamicStructuredTool) which is useless; fall back only if 1/2 miss.
      const t = tool as { name?: string; id?: string[] };
      const lastIdSeg = Array.isArray(t.id) ? t.id[t.id.length - 1] : undefined;
      const name =
        runName ??
        t.name ??
        (lastIdSeg && lastIdSeg !== "DynamicStructuredTool" ? lastIdSeg : undefined) ??
        "unknown_tool";
      // Cache the name on the runId so handleToolEnd can echo it back.
      names.set(runId, name);
      log.info(`tool → ${name}`, {
        ...extraMeta,
        input: trunc(asString(input)),
        ...(tags && tags.length ? { tags } : {}),
      });
    }

    handleToolEnd(output: unknown, runId: string): void {
      const ms = starts.has(runId) ? Date.now() - (starts.get(runId) ?? 0) : undefined;
      const name = names.get(runId) ?? "unknown_tool";
      starts.delete(runId);
      names.delete(runId);
      const out =
        typeof output === "string"
          ? output
          : output && typeof output === "object" && "content" in output
            ? asString((output as { content: unknown }).content)
            : asString(output);
      log.info(`tool ← ${name}`, {
        ...extraMeta,
        output: trunc(out),
        ...(ms !== undefined ? { ms } : {}),
      });
    }

    handleToolError(err: Error, runId: string): void {
      const ms = starts.has(runId) ? Date.now() - (starts.get(runId) ?? 0) : undefined;
      const name = names.get(runId) ?? "unknown_tool";
      starts.delete(runId);
      names.delete(runId);
      log.warn(`tool ✖ ${name}`, {
        ...extraMeta,
        error: err?.message ?? String(err),
        ...(ms !== undefined ? { ms } : {}),
      });
    }
  })();
}
