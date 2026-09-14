import { posix } from "node:path";

import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileOperationError,
  FileUploadResponse,
} from "deepagents";
import type { DenoSandbox as DenoSandboxType } from "@langchain/deno";

import { env } from "./env.js";
import { createLogger } from "./logger.js";

const log = createLogger("core/sandbox-deno");

/**
 * True if the error message indicates the Deno sandbox/RPC connection died.
 * The SDK has no error code for this, so we substring-match.
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
 * Optional remote sandbox on Deno Deploy (paid plan feature).
 *
 * File transfer goes through the underlying SDK's binary-safe `fs.readFile` /
 * `fs.writeFile` — the `@langchain/deno` wrapper's `uploadFiles` /
 * `downloadFiles` round-trip content through UTF-8 and corrupt binaries.
 *
 * Connection-level failures are re-thrown (see {@link isSandboxClosedError})
 * so the sandbox manager can re-provision or fail over to the local sandbox.
 */
export class DenoSandboxProvider {
  readonly kind = "deno" as const;
  readonly #sandbox: DenoSandboxType;

  private constructor(sandbox: DenoSandboxType) {
    this.#sandbox = sandbox;
  }

  static async create(): Promise<DenoSandboxProvider> {
    // Lazy import: the Deno SDK is only loaded when this provider is chosen.
    const { DenoSandbox } = await import("@langchain/deno");
    const t0 = Date.now();
    const sandbox = await DenoSandbox.create({
      token: env.DENO_DEPLOY_TOKEN,
      ...(env.DENO_DEPLOY_ORG ? { org: env.DENO_DEPLOY_ORG } : {}),
      memory: env.JARVIS_SANDBOX_MEMORY as never,
      timeout: env.JARVIS_SANDBOX_TIMEOUT as "session",
    });
    log.info("Deno sandbox ready", { id: sandbox.id, elapsed_ms: Date.now() - t0 });
    return new DenoSandboxProvider(sandbox);
  }

  get id(): string {
    return `deno-${this.#sandbox.id}`;
  }

  get isRunning(): boolean {
    return this.#sandbox.isRunning;
  }

  /** Cheap liveness check (`fs.stat("/")` raced against a 3s timeout). */
  async probe(): Promise<boolean> {
    if (!this.#sandbox.isRunning) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#sandbox.instance.fs.stat("/"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("probe timed out")), 3000);
        }),
      ]);
      return true;
    } catch (err) {
      log.warn("Deno sandbox failed health probe", {
        id: this.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async execute(command: string): Promise<ExecuteResponse> {
    return this.#sandbox.execute(command);
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const fs = this.#sandbox.instance.fs;
    const results: FileUploadResponse[] = [];
    for (const [path, bytes] of files) {
      try {
        const parent = posix.dirname(path);
        if (parent && parent !== "/" && parent !== ".") {
          await fs.mkdir(parent, { recursive: true });
        }
        const buf = new Uint8Array(new ArrayBuffer(bytes.byteLength));
        buf.set(bytes);
        await fs.writeFile(path, buf);
        results.push({ path, error: null });
      } catch (err) {
        if (isSandboxClosedError(err)) throw err;
        results.push({ path, error: mapDenoError(err) });
      }
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const fs = this.#sandbox.instance.fs;
    const results: FileDownloadResponse[] = [];
    for (const path of paths) {
      try {
        const data = await fs.readFile(path);
        results.push({ path, content: new Uint8Array(data), error: null });
      } catch (err) {
        if (isSandboxClosedError(err)) throw err;
        results.push({ path, content: null, error: mapDenoError(err) });
      }
    }
    return results;
  }

  async close(): Promise<void> {
    if (!this.#sandbox.isRunning) return;
    try {
      await this.#sandbox.close();
    } catch {
      // already dead
    }
  }
}

function mapDenoError(err: unknown): FileOperationError {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("not found") || msg.includes("notfound")) return "file_not_found";
  if (msg.includes("is a directory") || msg.includes("is_directory")) return "is_directory";
  if (msg.includes("permission")) return "permission_denied";
  return "invalid_path";
}
