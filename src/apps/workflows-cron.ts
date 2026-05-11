/**
 * Workflow runner — single entrypoint for every deterministic scheduled task.
 *
 * Usage:
 *   workflows-cron list                         # list every registered workflow
 *   workflows-cron run <name>                   # run one and exit
 *
 * Examples (from package.json scripts):
 *   npm run workflow -- list
 *   npm run workflow -- run revolut-daily-expenses
 *
 * Production deployment: one systemd template service +
 * `OnCalendar=…` timer per workflow. See `docs/DEPLOYMENT.md` §13.
 *
 * The runner exits 0 on success, 1 on any failure inside the workflow,
 * and 2 on usage errors (unknown workflow, missing arg).
 */
import { createWhatsappClient } from "../apps/whatsapp/client.js";
import { closePool } from "../core/db.js";
import { hasCredential } from "../core/env.js";
import { createLogger } from "../core/logger.js";
import { closeSandbox } from "../core/sandbox.js";
import { WORKFLOWS, getWorkflow } from "../workflows/index.js";
import type { WorkflowContext } from "../workflows/index.js";

const log = createLogger("apps/workflows-cron");

function printUsage(out: NodeJS.WriteStream): void {
  out.write(
    [
      "usage: workflows-cron <command>",
      "",
      "commands:",
      "  list                list every registered workflow",
      "  run <name>          run a single workflow and exit (0 on success, 1 on failure)",
      "",
      "registered workflows:",
      ...WORKFLOWS.map((w) => `  ${w.name.padEnd(28)} ${w.description}`),
      "",
    ].join("\n"),
  );
}

async function runOne(name: string): Promise<number> {
  const workflow = getWorkflow(name);
  if (!workflow) {
    log.error("unknown workflow", {
      name,
      available: WORKFLOWS.map((w) => w.name),
    });
    return 2;
  }

  // Every workflow needs the WA REST client to report results back.
  // Fail-fast on missing creds so systemd surfaces a clean error.
  for (const k of ["WA_BOT_BASE_URL", "WA_BOT_TOKEN"] as const) {
    if (!hasCredential(k)) {
      log.error(`missing required env var: ${k}`);
      return 1;
    }
  }

  const wa = createWhatsappClient();
  const log_ = createLogger(`workflow/${workflow.name}`);
  const ctl = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    log.warn(`received ${signal} — aborting workflow`);
    ctl.abort(new Error(`process received ${signal}`));
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  const ctx: WorkflowContext = {
    wa,
    log: log_,
    signal: ctl.signal,
    startedAt: Date.now(),
  };

  log.info("workflow start", { name: workflow.name });
  const t0 = Date.now();
  try {
    await workflow.run(ctx);
    log.info("workflow ok", {
      name: workflow.name,
      duration_ms: Date.now() - t0,
    });
    return 0;
  } catch (err) {
    log.error("workflow failed", {
      name: workflow.name,
      duration_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    return 1;
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage(process.stdout);
    process.exit(cmd ? 0 : 2);
  }

  if (cmd === "list") {
    printUsage(process.stdout);
    process.exit(0);
  }

  if (cmd === "run") {
    const name = rest[0];
    if (!name) {
      log.error("`run` requires a workflow name");
      printUsage(process.stderr);
      process.exit(2);
    }
    const code = await runOne(name);
    // Best-effort cleanup of shared singletons before exit so systemd doesn't
    // see lingering "client never closed" warnings.
    await Promise.allSettled([closePool(), closeSandbox()]);
    process.exit(code);
  }

  log.error(`unknown command: ${cmd}`);
  printUsage(process.stderr);
  process.exit(2);
}

main().catch(async (err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  await Promise.allSettled([closePool(), closeSandbox()]);
  process.exit(1);
});
