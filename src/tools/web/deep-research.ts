import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { env, hasCredential } from "../../core/env.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("tools/tavily-deep-research");

const RESEARCH_URL = "https://api.tavily.com/research";
/** Pro research can run several minutes; stay under typical HTTP client timeouts. */
const MAX_WAIT_MS = 12 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readTavilyError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: { error?: string } };
    return j.detail?.error ?? `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/**
 * Parse optional Tavily `output_schema` JSON. Tavily requires a top-level
 * `properties` object per their API.
 */
function parseOutputSchemaJson(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("output_schema_json must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("output_schema_json must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const props = o.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Error(
      "output_schema_json must include a 'properties' object with field schemas (see Tavily Research output_schema)",
    );
  }
  return o;
}

interface ResearchCompleted {
  status: "completed";
  request_id: string;
  created_at?: string;
  content: string | Record<string, unknown>;
  sources: Array<{ title?: string; url?: string; favicon?: string | null }>;
  response_time?: number;
}

interface ResearchFailed {
  status: "failed";
  request_id: string;
  response_time?: number;
}

interface ResearchPending {
  status: "pending" | "in_progress";
  request_id: string;
  response_time?: number;
}

/**
 * Tavily Research (multi-step search + synthesis) with **model: pro**.
 * Polls until completed, failed, timeout, or abort.
 */
export const tavilyDeepResearch = tool(
  async (
    {
      research_brief,
      output_schema_json,
      citation_format,
    }: {
      research_brief: string;
      output_schema_json?: string;
      citation_format?: "numbered" | "mla" | "apa" | "chicago";
    },
    runtime: ToolRuntime<unknown, unknown>,
  ) => {
    if (!hasCredential("TAVILY_API_KEY")) {
      log.warn("tavily_deep_research called but TAVILY_API_KEY is not set");
      return JSON.stringify({
        ok: false,
        error:
          "Deep research is unavailable: TAVILY_API_KEY is not configured. Same key as web search.",
      });
    }

    let output_schema: Record<string, unknown> | undefined;
    try {
      output_schema = parseOutputSchemaJson(output_schema_json);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return JSON.stringify({ ok: false, error: message });
    }

    const apiKey = env.TAVILY_API_KEY!;
    const signal = runtime.signal;

    const body: Record<string, unknown> = {
      input: research_brief,
      model: "pro",
      stream: false,
      citation_format: citation_format ?? "numbered",
    };
    if (output_schema) body.output_schema = output_schema;

    const t0 = Date.now();
    let createRes: Response;
    try {
      createRes = await fetch(RESEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("research POST failed", { message });
      return JSON.stringify({ ok: false, error: message });
    }

    if (!createRes.ok) {
      const errText = await readTavilyError(createRes);
      log.warn("research POST rejected", { status: createRes.status, errText });
      return JSON.stringify({
        ok: false,
        error: errText,
        status: createRes.status,
      });
    }

    const created = (await createRes.json()) as { request_id?: string };
    const requestId = created.request_id;
    if (!requestId) {
      return JSON.stringify({
        ok: false,
        error: "Tavily did not return request_id from POST /research",
      });
    }

    log.info("research task created", { request_id: requestId, ms: Date.now() - t0 });

    while (Date.now() - t0 < MAX_WAIT_MS) {
      if (signal?.aborted) {
        return JSON.stringify({
          ok: false,
          error: "aborted",
          request_id: requestId,
          partial_note:
            "Research was cancelled mid-run. The task may still complete on Tavily's side.",
        });
      }

      let statusRes: Response;
      try {
        statusRes = await fetch(`${RESEARCH_URL}/${encodeURIComponent(requestId)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("research GET failed", { request_id: requestId, message });
        return JSON.stringify({ ok: false, error: message, request_id: requestId });
      }

      if (statusRes.status === 202) {
        await sleep(POLL_INTERVAL_MS, signal);
        continue;
      }

      if (!statusRes.ok) {
        const errText = await readTavilyError(statusRes);
        return JSON.stringify({
          ok: false,
          error: errText,
          request_id: requestId,
          status: statusRes.status,
        });
      }

      const data = (await statusRes.json()) as
        | ResearchCompleted
        | ResearchFailed
        | ResearchPending;

      if (data.status === "pending" || data.status === "in_progress") {
        await sleep(POLL_INTERVAL_MS, signal);
        continue;
      }

      if (data.status === "failed") {
        log.warn("research failed", { request_id: requestId });
        return JSON.stringify({
          ok: false,
          status: "failed",
          request_id: data.request_id,
          response_time: data.response_time,
        });
      }

      if (data.status === "completed") {
        const elapsed_s = Math.round((Date.now() - t0) / 1000);
        log.info("research completed", {
          request_id: requestId,
          sources: data.sources?.length,
          elapsed_s,
        });
        return JSON.stringify({
          ok: true,
          request_id: data.request_id,
          created_at: data.created_at,
          content: data.content,
          sources: data.sources,
          response_time: data.response_time,
          elapsed_s,
        });
      }

      await sleep(POLL_INTERVAL_MS, signal);
    }

    return JSON.stringify({
      ok: false,
      error: `Research still in progress after ${MAX_WAIT_MS / 60000} minutes`,
      request_id: requestId,
      hint: "Poll Tavily later with GET /research/{request_id} or re-run with a narrower brief.",
    });
  },
  {
    name: "tavily_deep_research",
    description:
      "Run **Tavily Research** (model **pro**): multi-search, multi-source synthesis into a full report. Use for **comprehensive** topics — market landscapes, competitor deep dives, policy summaries, due-diligence briefs, anything that needs more than a quick `internet_search`. " +
      "**Write a rich `research_brief`**: the goal, scope (geography/timeframe), angles to cover, depth, and what a good answer must include. " +
      "Optionally pass `output_schema_json` (stringified JSON Schema with a top-level `properties` object) so Tavily returns **structured** JSON instead of only prose. " +
      "Slower and pricier than `internet_search`; use `internet_search` for simple fact lookups. " +
      "Can take several minutes; warn the user on WhatsApp if relevant.",
    schema: z.object({
      research_brief: z
        .string()
        .min(20)
        .describe(
          "Detailed research mandate: core question, scope (regions, dates), subtopics, required sections, and how the final output will be used. Longer / clearer briefs yield better reports.",
        ),
      output_schema_json: z
        .string()
        .optional()
        .describe(
          "Optional. Stringified JSON Schema for Tavily's `output_schema` (must include `properties` with typed fields + `description` per field). Use when you need machine-parseable sections (e.g. executive_summary, risks, sources_table). Omit for a free-form markdown-style report string in `content`.",
        ),
      citation_format: z
        .enum(["numbered", "mla", "apa", "chicago"])
        .optional()
        .describe("Citation style for the narrative report. Default numbered."),
    }),
  },
);
