import path from "node:path";

import {
  createDeepAgent,
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  type SubAgent,
  type AnyBackendProtocol,
} from "deepagents";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { InteropZodObject } from "@langchain/core/utils/types";
import type { AgentMiddleware } from "langchain";

import {
  loadComposioTools,
  type ComposioToolsConfig,
} from "../tools/composio/index.js";

import { resolveModel } from "./models.js";
import { createLogger } from "./logger.js";
import { getSandbox, isSandboxConfigured } from "./sandbox.js";
import { createSkillsSandboxSyncMiddleware } from "./skills-sync.js";

const log = createLogger("core/agent");

/**
 * Repo-relative location where every skill set lives.
 * Subdirectories of this folder are the skill set names that agents reference
 * via `skillSets: ["jarvis", "shopify", ...]`.
 */
const SKILLS_ROOT = path.resolve(process.cwd(), "skills");

/**
 * Virtual base path where skills are mounted in the agent's filesystem.
 *
 * We deliberately mirror the Deno sandbox working directory (`/home/app`)
 * because:
 *   1. when running with a sandbox, this is the only place we can `uploadFiles`
 *      to – Deno's SDK rejects top-level paths like `/skills/...` with an
 *      `is_directory` error since `/` is read-only,
 *   2. using the same prefix in both sandbox and no-sandbox mode keeps every
 *      `read_file` / `execute` path the agent sees stable across configs.
 *
 * The agent therefore always sees skill files at
 * `/home/app/skills/<set>/<skill>/SKILL.md`, both as virtual filesystem
 * entries (via the FilesystemBackend route) and as physical files inside
 * the sandbox (via the upload middleware).
 */
const SKILLS_VIRTUAL_PREFIX = "/home/app/skills";

function skillSetsToPaths(skillSets: readonly string[]): string[] {
  return skillSets.map((name) => `${SKILLS_VIRTUAL_PREFIX}/${name}/`);
}

/**
 * Declarative description of a subagent. Mirrors {@link AgentDefinition} but
 * without checkpointer / memory concerns (subagents share the parent's harness)
 * and with everything optional except identity + prompt.
 *
 * Composio tools and skill sets are resolved at build time so subagent
 * definitions stay declarative.
 */
export interface SubAgentDefinition {
  /** Identifier the main agent uses to call this subagent via the `task` tool. */
  name: string;
  /** Action-oriented description. Drives delegation decisions in the parent. */
  description: string;
  /** Subagent-specific system prompt. Subagents do NOT inherit the parent's. */
  systemPrompt: string;
  /** Local tools the subagent has direct access to. */
  tools?: StructuredTool[];
  /** Composio toolkits / tools to load and merge into `tools` at build time. */
  composio?: ComposioToolsConfig;
  /** Override the parent's model for this subagent (string id or instance). */
  model?: string | BaseChatModel;
  /** Skill sets to expose to the subagent (subdirectories of `/skills/`). */
  skillSets?: string[];
}

/**
 * High-level config for any Jarvis agent. This is a thin, opinionated wrapper
 * over `createDeepAgent` so that:
 *
 *   1. every agent in this repo is built the same way,
 *   2. our sane defaults (model, checkpointer, logging) are applied centrally,
 *   3. agent files stay declarative – they mostly describe *what* the agent is,
 *      not *how* the deepagents harness should be wired up.
 */
export interface AgentDefinition {
  /** Stable identifier used by the CLI / registry. */
  name: string;
  /** Short human description (also surfaced in CLI help). */
  description: string;
  /** Custom system prompt added on top of the deepagents base prompt. */
  systemPrompt: string;
  /** Tools the agent should have direct access to. */
  tools: StructuredTool[];
  /**
   * Composio toolkits / tools to load and merge into `tools` at build time.
   * No-ops gracefully when `COMPOSIO_API_KEY` isn't set.
   */
  composio?: ComposioToolsConfig;
  /**
   * Subagents the harness should expose via the `task` tool.
   * Each one is resolved (composio tools + skill paths) at build time.
   */
  subagents?: SubAgentDefinition[];
  /**
   * Skill sets to expose to the main agent. Each entry is the name of a
   * subdirectory under `<repo>/skills/`. The general-purpose subagent
   * inherits these automatically; custom subagents do not (they declare
   * their own `skillSets`).
   */
  skillSets?: string[];
  /** Override the default model (string id or pre-built model instance). */
  model?: string | BaseChatModel;
  /** Override the default temperature. */
  temperature?: number;
  /**
   * Controls multi-turn memory.
   *   - `true`  (default): attach a fresh in-memory `MemorySaver`.
   *   - `false`: no checkpointer (single-shot invocations).
   *   - a `BaseCheckpointSaver` instance: bring your own (e.g. SQLite, Redis).
   *
   * Note: deepagents/LangGraph rejects `checkpointer: true` at the root graph
   * level, so we always materialise an instance here.
   */
  enableMemory?: boolean | BaseCheckpointSaver;
  /**
   * Optional Zod schema describing the per-run `context` object the frontend
   * will pass into `agent.invoke({ context: {...} })`. Tools read it via
   * `runtime.context`. The WhatsApp app uses this to plumb `chatJid`,
   * `triggeringSeq`, etc. through to its tools.
   */
  contextSchema?: InteropZodObject;
  /**
   * Extra LangGraph middleware to merge with the auto-derived ones (currently
   * just the optional skills-sync middleware). Useful for the WhatsApp app
   * which adds a per-run rate-limit middleware via `wrapToolCall`.
   */
  extraMiddleware?: AgentMiddleware[];
}

/**
 * Resolve a {@link SubAgentDefinition} into the {@link SubAgent} shape that
 * `createDeepAgent` accepts.
 */
async function resolveSubAgent(def: SubAgentDefinition): Promise<SubAgent> {
  const composioTools = def.composio
    ? await loadComposioTools(def.composio)
    : [];
  const tools = [...(def.tools ?? []), ...composioTools];

  const out: SubAgent = {
    name: def.name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    tools,
  };
  if (def.model !== undefined) out.model = def.model;
  if (def.skillSets?.length) {
    out.skills = skillSetsToPaths(def.skillSets);
  }
  return out;
}

/**
 * Builds a ready-to-invoke deep agent for the given definition.
 *
 * Returns the LangGraph compiled graph produced by `createDeepAgent`, so the
 * caller can use `.invoke`, `.stream`, etc. just like any other LangGraph agent.
 */
export async function buildAgent(def: AgentDefinition) {
  const model =
    typeof def.model === "string" || def.model === undefined
      ? await resolveModel({ model: def.model, temperature: def.temperature })
      : def.model;

  const memory = def.enableMemory ?? true;
  const checkpointer: BaseCheckpointSaver | undefined =
    memory === false
      ? undefined
      : memory === true
        ? new MemorySaver()
        : memory;

  const composioTools = def.composio
    ? await loadComposioTools(def.composio)
    : [];
  const tools = [...def.tools, ...composioTools];

  const subagents = def.subagents
    ? await Promise.all(def.subagents.map(resolveSubAgent))
    : undefined;

  // Whether *any* agent or subagent declares a skill set – determines whether
  // we need to mount `/skills/` in the harness virtual filesystem.
  const wantsSkills =
    (def.skillSets?.length ?? 0) > 0 ||
    (def.subagents?.some((s) => (s.skillSets?.length ?? 0) > 0) ?? false);

  // Sandbox decision:
  //   - if DENO_DEPLOY_TOKEN is set, use a shared Deno sandbox as the default
  //     backend so the agent gets an `execute` tool (shell access) AND we can
  //     upload skill scripts into it.
  //   - if not, fall back to the ephemeral StateBackend (no shell).
  // Sandbox provisioning is best-effort: if it fails, we degrade gracefully
  // to the no-shell mode rather than failing the build.
  const sandbox = isSandboxConfigured() ? await getSandbox() : null;

  const skillsRouteKey = `${SKILLS_VIRTUAL_PREFIX}/`;
  const backend: AnyBackendProtocol | undefined = (() => {
    if (sandbox && wantsSkills) {
      return new CompositeBackend(sandbox, {
        [skillsRouteKey]: new FilesystemBackend({
          rootDir: SKILLS_ROOT,
          virtualMode: true,
        }),
      });
    }
    if (sandbox) {
      return sandbox;
    }
    if (wantsSkills) {
      return new CompositeBackend(new StateBackend(), {
        [skillsRouteKey]: new FilesystemBackend({
          rootDir: SKILLS_ROOT,
          virtualMode: true,
        }),
      });
    }
    return undefined;
  })();

  // When the sandbox is the default backend AND we have skill sets, sync the
  // host skill files into the sandbox before each invocation so the agent
  // can actually `execute` scripts that ship with a skill.
  const skillsMiddleware =
    sandbox && wantsSkills
      ? [
          createSkillsSandboxSyncMiddleware({
            sandbox,
            skillsRoot: SKILLS_ROOT,
            virtualPrefix: SKILLS_VIRTUAL_PREFIX,
          }),
        ]
      : [];
  const middlewareList = [...skillsMiddleware, ...(def.extraMiddleware ?? [])];
  const middleware = middlewareList.length > 0 ? middlewareList : undefined;

  const agentSkills = def.skillSets?.length
    ? skillSetsToPaths(def.skillSets)
    : undefined;

  log.info(`Building agent "${def.name}"`, {
    tools: tools.map((t) => t.name),
    localTools: def.tools.length,
    composioTools: composioTools.length,
    subagents: subagents?.map((s) => s.name) ?? [],
    skillSets: def.skillSets ?? [],
    memory: checkpointer ? "enabled" : "disabled",
    sandbox: sandbox ? `deno:${sandbox.id}` : "off",
  });

  const agent = createDeepAgent({
    name: def.name,
    model,
    tools,
    systemPrompt: def.systemPrompt,
    ...(subagents ? { subagents } : {}),
    ...(checkpointer ? { checkpointer } : {}),
    ...(backend ? { backend } : {}),
    ...(agentSkills ? { skills: agentSkills } : {}),
    ...(middleware ? { middleware } : {}),
    ...(def.contextSchema ? { contextSchema: def.contextSchema } : {}),
  });

  return agent;
}

export type DeepAgent = Awaited<ReturnType<typeof buildAgent>>;
