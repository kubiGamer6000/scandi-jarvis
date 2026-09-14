import { initChatModel } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { env } from "./env.js";

/**
 * Build the default chat model used across Jarvis.
 *
 * Defaults to Claude Opus 5 (`JARVIS_MODEL`). We always go through
 * `initChatModel` so we get one consistent provider:model resolution path.
 *
 * Anthropic options applied here:
 *   - `effort` (`JARVIS_EFFORT`): thinking depth / token spend. Unset = the
 *     API default (`high`). Opus 5 thinks adaptively by default, so simple
 *     turns stay quick either way.
 *   - fast mode (`JARVIS_FAST_MODE`): Opus 5 / 4.8 only, ~2.5x faster output
 *     at premium pricing.
 *   - refusal fallbacks (`JARVIS_REFUSAL_FALLBACK`): on Opus 5 / Fable, a
 *     safety-classifier decline is retried server-side on a fallback model
 *     instead of ending the turn.
 *
 * Temperature is **omitted by default** — Opus 4.7+ / Sonnet 5+ reject
 * sampling params. Set it only for older models.
 */
export interface ResolveModelOptions {
  /** "<provider>:<model-id>", e.g. "anthropic:claude-opus-5". */
  model?: string;
  /** Sampling temperature (older models only). */
  temperature?: number;
  /** Override `JARVIS_EFFORT` for this model instance. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Override `JARVIS_FAST_MODE` for this model instance. */
  fast?: boolean;
}

const FAST_MODE_MODELS = ["claude-opus-5", "claude-opus-4-8"];
const REFUSAL_FALLBACK_MODELS = ["claude-opus-5", "claude-fable-5"];

export async function resolveModel(
  options: ResolveModelOptions = {},
): Promise<BaseChatModel> {
  const model = options.model ?? env.JARVIS_MODEL;
  const temperature = options.temperature ?? env.JARVIS_TEMPERATURE;
  const [provider, modelId = ""] = model.includes(":")
    ? model.split(/:(.*)/s)
    : ["", model];

  const fields: Record<string, unknown> = {};
  if (temperature !== undefined) fields.temperature = temperature;

  if (provider === "anthropic" || modelId.startsWith("claude-")) {
    const betas: string[] = [];
    const invocationKwargs: Record<string, unknown> = {};

    const effort = options.effort ?? env.JARVIS_EFFORT;
    if (effort) fields.outputConfig = { effort };

    const fast = options.fast ?? env.JARVIS_FAST_MODE === "true";
    if (fast && FAST_MODE_MODELS.some((m) => modelId.startsWith(m))) {
      betas.push("fast-mode-2026-02-01");
      invocationKwargs.speed = "fast";
    }

    if (
      env.JARVIS_REFUSAL_FALLBACK === "true" &&
      REFUSAL_FALLBACK_MODELS.some((m) => modelId.startsWith(m))
    ) {
      betas.push("server-side-fallback-2026-07-01");
      invocationKwargs.fallbacks = "default";
    }

    if (betas.length > 0) fields.betas = betas;
    if (Object.keys(invocationKwargs).length > 0) {
      fields.invocationKwargs = invocationKwargs;
    }
  }

  return (await initChatModel(model, fields)) as unknown as BaseChatModel;
}

/** Convenience constant: the default model identifier string. */
export const DEFAULT_MODEL = env.JARVIS_MODEL;
