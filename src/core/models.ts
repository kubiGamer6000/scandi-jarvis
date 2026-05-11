import { initChatModel } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { env } from "./env.js";

/**
 * Build the default chat model used across Jarvis.
 *
 * Defaults to Claude Opus 4.6 (per project decision) but every parameter can be
 * overridden via env vars or per-agent overrides. We always go through
 * `initChatModel` so we get one consistent provider:model resolution path.
 */
export interface ResolveModelOptions {
  /** "<provider>:<model-id>", e.g. "anthropic:claude-opus-4-6". */
  model?: string;
  /** Sampling temperature. Defaults to env JARVIS_TEMPERATURE. */
  temperature?: number;
}

export async function resolveModel(
  options: ResolveModelOptions = {},
): Promise<BaseChatModel> {
  const model = options.model ?? env.JARVIS_MODEL;
  const temperature = options.temperature ?? env.JARVIS_TEMPERATURE;

  return initChatModel(model, { temperature });
}

/** Convenience constant: the default model identifier string. */
export const DEFAULT_MODEL = env.JARVIS_MODEL;
