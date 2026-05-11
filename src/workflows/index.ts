import { revolutDailyExpenses } from "./revolut-daily-expenses/index.js";
import type { WorkflowDefinition } from "./types.js";

export type { WorkflowContext, WorkflowDefinition } from "./types.js";

/**
 * Registry of every deterministic scheduled workflow.
 *
 * Add a new workflow here once you've created its directory under
 * `src/workflows/<name>/index.ts`. The CLI runner (`src/apps/workflows-cron.ts`)
 * looks tasks up by `definition.name`, NOT the object key — keep them in sync.
 *
 * Naming convention: lowercase, hyphenated, filesystem-safe. The same name
 * is used as the systemd template instance argument
 * (`scandi-jarvis-workflow@<name>.service`).
 */
export const WORKFLOWS: WorkflowDefinition[] = [revolutDailyExpenses];

export function getWorkflow(name: string): WorkflowDefinition | undefined {
  return WORKFLOWS.find((w) => w.name === name);
}
