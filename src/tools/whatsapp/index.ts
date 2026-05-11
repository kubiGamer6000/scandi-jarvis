import type { AnyBackendProtocol } from "deepagents";
import type { StructuredTool } from "@langchain/core/tools";

import type { WhatsappClient } from "../../apps/whatsapp/client.js";

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
   * Optional backend override for `pull-file` / `send-file`. Defaults to
   * a `StateBackend` (writes to LangGraph state), which works for any agent.
   *
   * Pass the agent's actual backend (e.g. a Deno sandbox) here if you want
   * pulled files to land in the sandbox FS so the agent can `execute` against
   * them. The WA app wires this when a sandbox is configured.
   */
  backend?: AnyBackendProtocol;
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
  const fileOpts = options.backend !== undefined ? { backend: options.backend } : {};
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
