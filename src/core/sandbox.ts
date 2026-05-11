import { DenoSandbox } from "@langchain/deno";
import type { Memory } from "@deno/sandbox";

import { env, hasCredential } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("core/sandbox");

/**
 * Process-wide singleton wrapper around a {@link DenoSandbox}.
 *
 * Why a singleton:
 *   - sandboxes cost money + take a few seconds to provision; we don't want
 *     to spin one up per `buildAgent()` call (the LangGraph dev server alone
 *     calls `buildAgent` 4–5 times during graph initialisation),
 *   - subagents share the parent's backend, so all agents in this process
 *     share one sandbox (which is what we want for cost + latency anyway),
 *   - the `langgraph dev` server is long-lived – one sandbox per dev session
 *     is the right granularity.
 *
 * Lifetime:
 *   - controlled by {@link env.JARVIS_SANDBOX_TIMEOUT} (default `"session"`,
 *     which means the sandbox dies when this Node process disconnects),
 *   - we also register `SIGINT` / `SIGTERM` / `beforeExit` handlers that
 *     best-effort `close()` the sandbox so we don't leave it hanging on the
 *     Deno side.
 *
 * Returns `null` (and does NOT throw) when no `DENO_DEPLOY_TOKEN` is
 * configured – callers should treat sandbox support as opt-in.
 */
let sandboxPromise: Promise<DenoSandbox | null> | null = null;
let cleanupRegistered = false;

export function isSandboxConfigured(): boolean {
  return hasCredential("DENO_DEPLOY_TOKEN");
}

/**
 * Lazily get (or create) the shared Deno sandbox for this process.
 *
 * - First call: provisions a fresh sandbox (this can take several seconds).
 * - Subsequent calls: return the same instance.
 * - Returns `null` when `DENO_DEPLOY_TOKEN` is unset.
 */
export async function getSandbox(): Promise<DenoSandbox | null> {
  if (!isSandboxConfigured()) return null;

  if (sandboxPromise) return sandboxPromise;

  registerCleanup();

  sandboxPromise = (async () => {
    const t0 = Date.now();
    log.info("Provisioning Deno sandbox", {
      timeout: env.JARVIS_SANDBOX_TIMEOUT,
      memory: env.JARVIS_SANDBOX_MEMORY,
    });
    try {
      const sandbox = await DenoSandbox.create({
        token: env.DENO_DEPLOY_TOKEN,
        ...(env.DENO_DEPLOY_ORG ? { org: env.DENO_DEPLOY_ORG } : {}),
        memory: env.JARVIS_SANDBOX_MEMORY as Memory,
        timeout: env.JARVIS_SANDBOX_TIMEOUT as "session" | `${number}s` | `${number}m`,
      });
      log.info("Deno sandbox ready", {
        id: sandbox.id,
        elapsed_ms: Date.now() - t0,
      });
      return sandbox;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to provision Deno sandbox – falling back to no-shell mode", {
        error: message,
      });
      sandboxPromise = null;
      return null;
    }
  })();

  return sandboxPromise;
}

/**
 * Best-effort shutdown of the shared sandbox. Safe to call multiple times.
 *
 * The CLI calls this on graceful exit; the auto-registered process hooks call
 * it on SIGINT/SIGTERM/beforeExit. After this returns the singleton is reset,
 * so a subsequent `getSandbox()` would provision a fresh one.
 */
export async function closeSandbox(): Promise<void> {
  const pending = sandboxPromise;
  sandboxPromise = null;
  if (!pending) return;
  try {
    const sandbox = await pending;
    if (sandbox && sandbox.isRunning) {
      log.info("Closing Deno sandbox", { id: sandbox.id });
      await sandbox.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("sandbox.close() failed", { error: message });
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const onSignal = (signal: NodeJS.Signals) => {
    log.info(`Received ${signal} – shutting down sandbox`);
    void closeSandbox().finally(() => {
      // Re-raise so the rest of the process exits with the conventional code.
      process.kill(process.pid, signal);
    });
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("beforeExit", () => {
    void closeSandbox();
  });
}
