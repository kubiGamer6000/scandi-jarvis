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
 * True if the error message indicates the sandbox/RPC connection has died.
 *
 * The Deno SDK exposes this as plain `Error("Connection to the sandbox was
 * already closed")` from `fs.*` calls, or as `DenoSandboxError` with messages
 * like "Failed to execute…: …closed" from `execute()`. There's no error code
 * we can switch on, so we substring-match.
 */
export function isSandboxClosedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("already closed") ||
    msg.includes("connection closed") ||
    msg.includes("sandbox is closed") ||
    msg.includes("not initialized")
  );
}

/**
 * Cheap health probe to confirm the cached sandbox still works.
 *
 * We deliberately avoid `execute()` (heavier; goes through bash) and use a
 * direct RPC `fs.stat("/")`. The SDK's `fs.stat` doesn't accept a signal so
 * we race it against a 3s timeout to avoid hanging forever on a half-open
 * connection. ~hundreds of ms when the sandbox is healthy; throws (or times
 * out) when the connection is dead.
 */
async function probeSandbox(sandbox: DenoSandbox): Promise<boolean> {
  if (!sandbox.isRunning) return false;
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("sandbox probe timed out after 3000ms")),
        3000,
      );
    });
    try {
      await Promise.race([sandbox.instance.fs.stat("/"), timeout]);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    log.warn("Cached sandbox failed health probe – will re-provision", {
      id: sandbox.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function provisionSandbox(): Promise<DenoSandbox | null> {
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
    return null;
  }
}

/**
 * Lazily get (or create) the shared Deno sandbox for this process.
 *
 * - First call: provisions a fresh sandbox (this can take several seconds).
 * - Subsequent calls: probe the cached handle with a cheap `fs.stat("/")`
 *   and return it if alive. If the probe fails (e.g. the sandbox timed out
 *   on the Deno side — `JARVIS_SANDBOX_TIMEOUT="session"` dies when the
 *   client connection blips), the cache is cleared and a fresh sandbox is
 *   provisioned.
 * - Pass `{ force: true }` to bypass the cache entirely (used after we know
 *   a call just hit a closed-connection error and we want to retry).
 * - Returns `null` when `DENO_DEPLOY_TOKEN` is unset.
 */
export async function getSandbox(
  opts: { force?: boolean } = {},
): Promise<DenoSandbox | null> {
  if (!isSandboxConfigured()) return null;

  registerCleanup();

  if (opts.force) {
    await resetSandbox();
  } else if (sandboxPromise) {
    const cached = await sandboxPromise;
    if (cached && (await probeSandbox(cached))) {
      return cached;
    }
    // Probe failed – clear and fall through to re-provision.
    sandboxPromise = null;
    // Best-effort close of the dead handle so we don't leak it on the Deno side.
    if (cached) {
      try {
        await cached.close();
      } catch {
        // already dead – nothing to do
      }
    }
  }

  if (!sandboxPromise) {
    sandboxPromise = provisionSandbox().then((sandbox) => {
      if (sandbox === null) sandboxPromise = null;
      return sandbox;
    });
  }
  return sandboxPromise;
}

/**
 * Drop the cached sandbox handle. Best-effort closes the underlying sandbox
 * if it's still considered running. Next `getSandbox()` will provision a
 * fresh one. Safe to call multiple times concurrently.
 *
 * Useful after a caller catches a "Connection to the sandbox was already
 * closed" error and wants to retry against a fresh sandbox.
 */
export async function resetSandbox(): Promise<void> {
  const pending = sandboxPromise;
  sandboxPromise = null;
  if (!pending) return;
  try {
    const sandbox = await pending;
    if (sandbox && sandbox.isRunning) {
      try {
        await sandbox.close();
      } catch {
        // already dead
      }
    }
  } catch {
    // provisioning never succeeded
  }
}

/**
 * Best-effort shutdown of the shared sandbox. Safe to call multiple times.
 *
 * The CLI calls this on graceful exit; the auto-registered process hooks call
 * it on SIGINT/SIGTERM/beforeExit. After this returns the singleton is reset,
 * so a subsequent `getSandbox()` would provision a fresh one.
 *
 * Functionally equivalent to {@link resetSandbox} but logs at info level
 * (this is an intentional shutdown rather than a recovery).
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
