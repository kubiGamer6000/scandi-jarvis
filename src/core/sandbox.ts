import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
} from "deepagents";

import { env, hasCredential } from "./env.js";
import { createLogger } from "./logger.js";
import { DenoSandboxProvider, isSandboxClosedError } from "./sandbox-deno.js";
import { LocalSandbox } from "./sandbox-local.js";

const log = createLogger("core/sandbox");

type Provider = LocalSandbox | DenoSandboxProvider;

/** After Deno fails, stay on the local sandbox this long before retrying. */
const DENO_RETRY_COOLDOWN_MS = 15 * 60_000;

/**
 * The one sandbox every agent in this process shares.
 *
 * It is a stable object handed to `createDeepAgent` as the backend, and it
 * forwards `execute` / `uploadFiles` / `downloadFiles` to whichever provider
 * is currently live. Everything else (`read`, `write`, `edit`, `ls`, `grep`,
 * `glob`) comes from deepagents' `BaseSandbox`, built on those three.
 *
 * Providers (`JARVIS_SANDBOX_PROVIDER`):
 *   - `local` (default): bubblewrap-isolated shell on this host. Free, no
 *     network hop, survives anything short of the host going down.
 *   - `deno`: Deno Deploy sandbox first; if it can't be provisioned or its
 *     connection dies and can't be re-established, fail over to `local`, and
 *     try Deno again after a cooldown (at the start of a run, never mid-run).
 *   - `none`: no sandbox — agents get no `execute` tool.
 *
 * Because the agent holds this wrapper rather than a provider, a dead
 * provider is swapped out underneath it without rebuilding the agent.
 */
export class JarvisSandbox extends BaseSandbox {
  readonly #preference: "local" | "deno";
  #local: LocalSandbox | null = null;
  #active: Provider | null = null;
  #switching: Promise<Provider> | null = null;
  #denoRetryAt = 0;
  /** provider id + target → signature of the last successful directory sync. */
  readonly #synced = new Map<string, string>();

  constructor(preference: "local" | "deno") {
    super();
    this.#preference = preference;
  }

  get id(): string {
    return this.#active?.id ?? "jarvis-sandbox";
  }

  /** e.g. `local-1a2b3c4d` / `deno-…`, for logs. */
  describe(): string {
    return this.#active ? this.#active.id : "unavailable";
  }

  /** Provision the first provider. Returns false if none could start. */
  async start(): Promise<boolean> {
    try {
      await this.#current();
      return true;
    } catch (err) {
      log.error("No sandbox provider could be started – agents will run without `execute`", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Called at the start of every agent run: health-check a Deno provider and,
   * when running on the local fallback, retry Deno once the cooldown passes.
   */
  async refresh(): Promise<void> {
    const active = this.#active;
    if (active?.kind === "deno" && !(await active.probe())) {
      await this.#drop(active);
    }
    if (
      this.#preference === "deno" &&
      this.#active?.kind === "local" &&
      Date.now() >= this.#denoRetryAt
    ) {
      const deno = await this.#tryDeno();
      if (deno) {
        log.info("Deno sandbox is back – switching from local fallback", { id: deno.id });
        this.#active = deno;
      }
    }
    await this.#current().catch(() => undefined);
  }

  override async execute(command: string): Promise<ExecuteResponse> {
    try {
      return await this.#withProvider((p) => p.execute(command));
    } catch (err) {
      return {
        output: `Error: sandbox unavailable (${err instanceof Error ? err.message : String(err)})`,
        exitCode: 1,
        truncated: false,
      };
    }
  }

  override uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    return this.#withProvider((p) => p.uploadFiles(files));
  }

  override downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.#withProvider((p) => p.downloadFiles(paths));
  }

  /**
   * Mirror a host directory into the sandbox at `target` (replacing what was
   * there). Skipped when nothing changed since the last sync to the same
   * provider, so calling it every run is cheap.
   */
  async syncDirectory(hostDir: string, target: string): Promise<void> {
    const files = await walkFiles(hostDir);
    if (files.length === 0) return;

    const hash = createHash("sha256");
    for (const file of files) {
      const st = await stat(file);
      hash.update(`${file}\0${st.size}\0${st.mtimeMs}\n`);
    }
    const signature = hash.digest("hex");

    const provider = await this.#current();
    const key = `${provider.id}:${target}`;
    if (this.#synced.get(key) === signature) return;

    const payload: Array<[string, Uint8Array]> = [];
    for (const file of files) {
      const rel = path.relative(hostDir, file).split(path.sep).join("/");
      payload.push([path.posix.join(target, rel), new Uint8Array(await readFile(file))]);
    }

    const quoted = `'${target.replaceAll("'", "'\\''")}'`;
    await this.execute(`rm -rf ${quoted}`);
    const results = await this.uploadFiles(payload);
    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      log.warn("Some files failed to sync into the sandbox", {
        target,
        failed: failed.slice(0, 10).map((r) => ({ path: r.path, error: r.error })),
        failedCount: failed.length,
      });
      return;
    }
    // Uploads don't carry file modes; skills invoke scripts directly
    // (`scripts/search_docs.mjs …`), so restore the executable bit.
    await this.execute(
      `find ${quoted} -type f \\( -name '*.sh' -o -name '*.py' -o -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \\) -exec chmod +x {} +`,
    );
    // Key on the provider that actually received the files (a failover
    // mid-sync would have changed it).
    this.#synced.set(`${this.id}:${target}`, signature);
    log.debug("Synced directory into sandbox", {
      target,
      files: payload.length,
      provider: this.id,
    });
  }

  async close(): Promise<void> {
    const providers = new Set([this.#active, this.#local]);
    this.#active = null;
    this.#local = null;
    for (const p of providers) {
      if (!p) continue;
      log.info("Closing sandbox", { id: p.id });
      await p.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------

  async #withProvider<T>(op: (p: Provider) => Promise<T>): Promise<T> {
    const provider = await this.#current();
    try {
      return await op(provider);
    } catch (err) {
      if (provider.kind !== "deno" || !isSandboxClosedError(err)) throw err;
      log.warn("Deno sandbox connection closed – re-provisioning and retrying once", {
        id: provider.id,
      });
      await this.#drop(provider);
      return op(await this.#current());
    }
  }

  async #current(): Promise<Provider> {
    if (this.#active?.isRunning) return this.#active;
    if (!this.#switching) {
      this.#switching = this.#provision().finally(() => {
        this.#switching = null;
      });
    }
    return this.#switching;
  }

  async #provision(): Promise<Provider> {
    if (this.#preference === "deno" && Date.now() >= this.#denoRetryAt) {
      const deno = await this.#tryDeno();
      if (deno) return (this.#active = deno);
      log.warn("Falling back to the local sandbox", {
        retry_deno_in_min: DENO_RETRY_COOLDOWN_MS / 60_000,
      });
    }
    return (this.#active = await this.#getLocal());
  }

  async #tryDeno(): Promise<DenoSandboxProvider | null> {
    if (!hasCredential("DENO_DEPLOY_TOKEN")) {
      log.warn("JARVIS_SANDBOX_PROVIDER=deno but DENO_DEPLOY_TOKEN is not set");
      this.#denoRetryAt = Number.POSITIVE_INFINITY;
      return null;
    }
    try {
      return await DenoSandboxProvider.create();
    } catch (err) {
      this.#denoRetryAt = Date.now() + DENO_RETRY_COOLDOWN_MS;
      log.error("Failed to provision Deno sandbox", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async #getLocal(): Promise<LocalSandbox> {
    if (this.#local?.isRunning) return this.#local;
    const local = new LocalSandbox({
      rootDir: path.resolve(process.cwd(), env.JARVIS_SANDBOX_DIR),
      timeoutSec: env.JARVIS_SANDBOX_EXEC_TIMEOUT_SEC,
      maxOutputBytes: env.JARVIS_SANDBOX_MAX_OUTPUT_BYTES,
      maxFileMb: env.JARVIS_SANDBOX_MAX_FILE_MB,
      network: env.JARVIS_SANDBOX_NETWORK === "true",
      maxConcurrency: env.JARVIS_SANDBOX_MAX_CONCURRENCY,
    });
    await local.start();
    return (this.#local = local);
  }

  async #drop(provider: Provider): Promise<void> {
    if (this.#active === provider) this.#active = null;
    await provider.close();
  }
}

let sandboxPromise: Promise<JarvisSandbox | null> | null = null;

/** Whether this process is configured to use a sandbox at all. */
export function isSandboxConfigured(): boolean {
  return env.JARVIS_SANDBOX_PROVIDER !== "none";
}

/**
 * The process-wide sandbox, started on first call. Resolves to `null` when
 * the sandbox is disabled or no provider could start (logged loudly) — agents
 * then run without the `execute` tool.
 */
export function getSandbox(): Promise<JarvisSandbox | null> {
  const preference = env.JARVIS_SANDBOX_PROVIDER;
  if (preference === "none") return Promise.resolve(null);
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      const sandbox = new JarvisSandbox(preference);
      return (await sandbox.start()) ? sandbox : null;
    })();
  }
  return sandboxPromise;
}

/** Best-effort shutdown. Safe to call multiple times or when never started. */
export async function closeSandbox(): Promise<void> {
  const pending = sandboxPromise;
  sandboxPromise = null;
  const sandbox = await pending?.catch(() => null);
  await sandbox?.close();
}

async function walkFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (entry.isFile() && entry.name !== ".gitkeep") files.push(full);
  }
  return files.sort((a, b) => a.localeCompare(b));
}
