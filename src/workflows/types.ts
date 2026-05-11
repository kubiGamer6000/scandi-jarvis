import type { WhatsappClient } from "../apps/whatsapp/client.js";
import type { Logger } from "../core/logger.js";

/**
 * Runtime context passed to every workflow's `run()`.
 *
 * Workflows are deterministic, no-LLM cron tasks. They get the WA REST
 * client (so they can post results back to a chat), a scoped logger, and an
 * abort signal that the runner trips on SIGTERM / SIGINT (so a workflow can
 * exit cleanly mid-API-call when systemd restarts the unit).
 *
 * If you need additional infra (Postgres pool, Composio, …), import it
 * inside the workflow — keep this context minimal and stable.
 */
export interface WorkflowContext {
  wa: WhatsappClient;
  log: Logger;
  signal: AbortSignal;
  /**
   * When the runner started this workflow (ms since epoch). Use this — not
   * `Date.now()` — for any "report run timestamp" so retries / re-runs
   * remain reproducible.
   */
  startedAt: number;
}

/**
 * Declarative workflow registration. Each workflow lives in
 * `src/workflows/<name>/index.ts` and exports a default `WorkflowDefinition`.
 *
 * `name` MUST be filesystem-safe (lowercase letters, digits, hyphens) — it's
 * used directly as the systemd template instance argument
 * (`scandi-jarvis-workflow@<name>.service`) and the npm subcommand.
 */
export interface WorkflowDefinition {
  /** Stable identifier. Lowercase, hyphenated, filesystem-safe. */
  name: string;
  /** One-line human description (shown by `npm run workflow list`). */
  description: string;
  /**
   * Whether this workflow needs the Deno sandbox (e.g. for spawning shell
   * commands). Most don't — defaults to false. The runner skips sandbox
   * provisioning entirely when no workflow needs it.
   */
  needsSandbox?: boolean;
  /** The actual work. Throw to fail the run; the runner exits non-zero. */
  run(ctx: WorkflowContext): Promise<void>;
}
