import { createMiddleware } from "langchain";

import { createLogger } from "./logger.js";
import type { JarvisSandbox } from "./sandbox.js";

const log = createLogger("core/skills-sync");

/**
 * Build a `beforeAgent` middleware that mirrors `<skillsRoot>/...` from the
 * host into the sandbox at `<virtualPrefix>/...` before each agent run.
 *
 * Why: the deepagents harness reads `SKILL.md` through a `FilesystemBackend`
 * route over host disk, but scripts and assets inside a skill (`validate.mjs`,
 * `pack.py`, `schema.json.gz`, …) must physically exist inside the sandbox
 * for the agent to run them with `execute`. Skills are copied rather than
 * mounted so scripts that write next to themselves keep working.
 *
 * The sync is skipped when no skill file changed since the last run against
 * the same sandbox, and redone automatically after a provider switch. The
 * middleware also gives the sandbox a chance to health-check itself first.
 */
export function createSkillsSandboxSyncMiddleware(opts: {
  sandbox: JarvisSandbox;
  skillsRoot: string;
  virtualPrefix: string;
  /** Other host directories skills depend on (e.g. the Scandi kit). */
  extraDirs?: Array<{ hostDir: string; target: string }>;
}) {
  const { sandbox, skillsRoot, virtualPrefix, extraDirs = [] } = opts;

  return createMiddleware({
    name: "JarvisSkillsSandboxSync",
    beforeAgent: async () => {
      try {
        await sandbox.refresh();
        await sandbox.syncDirectory(skillsRoot, virtualPrefix);
        for (const dir of extraDirs) await sandbox.syncDirectory(dir.hostDir, dir.target);
      } catch (err) {
        // Never fail the run over this: the agent can still work, only skill
        // scripts would be missing.
        log.error("Skills sync into sandbox failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return undefined;
    },
  });
}
