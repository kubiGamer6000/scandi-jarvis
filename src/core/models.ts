import { initChatModel } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { env } from "./env.js";

/**
 * Build the default chat model used across Jarvis.
 *
 * Defaults to Claude Opus 4.6 (per project decision) but every parameter can be
 * overridden via env vars or per-agent overrides. We always go through
 * `initChatModel` so we get one consistent provider:model resolution path.
 *
 * Temperature is **omitted by default**. Anthropic's newer models (Opus 4.7+,
 * Sonnet 5+) return HTTP 400 if `temperature` / `top_p` / `top_k` are set to
 * any non-default value — see the Claude migration guide. Pass
 * `options.temperature` or set `JARVIS_TEMPERATURE` only for older models that
 * still accept sampling params.
 */
export interface ResolveModelOptions {
  /** "<provider>:<model-id>", e.g. "anthropic:claude-opus-4-6". */
  model?: string;
  /**
   * Sampling temperature. When omitted (and `JARVIS_TEMPERATURE` is unset),
   * the parameter is not sent to the provider at all.
   */
  temperature?: number;
}

export async function resolveModel(
  options: ResolveModelOptions = {},
): Promise<BaseChatModel> {
  const model = options.model ?? env.JARVIS_MODEL;
  const temperature = options.temperature ?? env.JARVIS_TEMPERATURE;

  if (temperature === undefined) {
    return initChatModel(model);
  }
  return initChatModel(model, { temperature });
}

/** Convenience constant: the default model identifier string. */
export const DEFAULT_MODEL = env.JARVIS_MODEL;
