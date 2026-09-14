import type { AnyBackendProtocol } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";

import type { WhatsappClient } from "../../apps/whatsapp/client.js";
import type { JarvisSandbox } from "../../core/sandbox.js";

import { createEditMessageTool } from "./edit-message.js";
import { createFetchMessagesTool } from "./fetch-messages.js";
import { createGetMessageTool } from "./get-message.js";
import { createPullFileTool } from "./pull-file.js";
import { createReactTool } from "./react.js";
import { createRememberTool } from "./remember.js";
import { createSendFileTool } from "./send-file.js";
import { createSendMessageTool } from "./send-message.js";

export { WhatsappContextSchema, type WhatsappContext } from "./runtime-context.js";

export interface CreateWhatsappToolsOptions {
  /**
   * Virtual-FS backend for `pull-file` / `send-file` when there is no
   * sandbox. Defaults to a `StateBackend` (files live in LangGraph state).
   */
  backend?: AnyBackendProtocol;
  /**
   * The agent's sandbox. When set, `pull-file` writes and `send-file` reads
   * raw bytes there, so files are shared with `write_file` / `execute` and
   * binaries round-trip intact.
   */
  sandbox?: JarvisSandbox;
}

/**
 * Build the full set of WhatsApp tools bound to a specific REST client.
 *
 * Tools read the per-run context (chatJid, triggeringSeq, ...) from
 * `runtime.context`, so they're safe to share across many concurrent agent
 * invocations as long as `agent.invoke` was given the right `context`.
 */
export function createWhatsappTools(
  client: WhatsappClient,
  options: CreateWhatsappToolsOptions = {},
): StructuredTool[] {
  const fileOpts = {
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
  };
  return [
    createSendMessageTool(client),
    createReactTool(client),
    createEditMessageTool(client),
    createPullFileTool(client, fileOpts),
    createSendFileTool(client, fileOpts),
    createFetchMessagesTool(client),
    createGetMessageTool(client),
    createRememberTool(),
  ];
}

export type WhatsappToolName =
  | "whatsapp_send_message"
  | "whatsapp_react"
  | "whatsapp_edit_message"
  | "whatsapp_pull_file"
  | "whatsapp_send_file"
  | "whatsapp_fetch_messages"
  | "whatsapp_get_message"
  | "whatsapp_remember";

export const WHATSAPP_TOOL_NAMES: readonly WhatsappToolName[] = [
  "whatsapp_send_message",
  "whatsapp_react",
  "whatsapp_edit_message",
  "whatsapp_pull_file",
  "whatsapp_send_file",
  "whatsapp_fetch_messages",
  "whatsapp_get_message",
  "whatsapp_remember",
];
