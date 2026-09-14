import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import type {
  ExecuteResponse,
  FileDownloadResponse,
  FileOperationError,
  FileUploadResponse,
} from "deepagents";
import PQueue from "p-queue";

import { createLogger } from "./logger.js";

const log = createLogger("core/sandbox-local");

/** Where the agent's workspace appears inside the sandbox. */
export const SANDBOX_HOME = "/home/app";

export interface LocalSandboxOptions {
  /**
   * Host directory holding all sandbox state:
   *   <dir>/home   → mounted read-write at /home/app (persistent workspace)
   *   <dir>/tmp    → mounted read-write at /tmp (wiped on process start)
   *   <dir>/tools  → mounted read-only at the same absolute path (Python venv,
   *                  node_modules) — provisioned by scripts/setup-sandbox.sh
   */
  rootDir: string;
  /** Per-command wall-clock limit in seconds. */
  timeoutSec: number;
  /** Cap on combined stdout+stderr returned to the agent. */
  maxOutputBytes: number;
  /** Max size of any single file a command may write. */
  maxFileMb: number;
  /** Allow outbound network from inside the sandbox. */
  network: boolean;
  /** Max commands running at once (the droplet has one vCPU). */
  maxConcurrency: number;
}

/**
 * A shell sandbox on the local host, isolated with bubblewrap (`bwrap`).
 *
 * Every `execute()` runs in a fresh set of Linux namespaces (user, pid, ipc,
 * uts, cgroup, and optionally net) with a minimal filesystem view:
 *
 *   /usr, /etc, /bin, /lib*   read-only from the host (system tools, python, node)
 *   /home/app                 read-write, persistent across commands
 *   /tmp                      read-write, persistent across commands
 *   <tools dir>               read-only (preinstalled venv + node_modules)
 *
 * What the sandbox can NOT see: /opt (so not the Jarvis repo or its `.env`),
 * /home, /root, /var, host processes (own pid namespace, so no
 * `/proc/<jarvis-pid>/environ`), or any Jarvis environment variable — the
 * child gets a small, explicit env.
 *
 * File transfer (`uploadFiles` / `downloadFiles`) happens host-side with raw
 * bytes, so binaries (.docx, .pdf, .zip…) round-trip exactly. Paths are
 * confined to the two writable mounts, and symlinks created by sandboxed code
 * are never followed out of them.
 */
export class LocalSandbox {
  readonly kind = "local" as const;
  readonly id = `local-${randomBytes(4).toString("hex")}`;

  readonly #opts: LocalSandboxOptions;
  readonly #homeDir: string;
  readonly #tmpDir: string;
  readonly #toolsDir: string;
  readonly #queue: PQueue;
  readonly #children = new Set<ChildProcess>();
  #baseArgs: string[] = [];
  #running = false;

  constructor(opts: LocalSandboxOptions) {
    this.#opts = opts;
    const root = path.resolve(opts.rootDir);
    this.#homeDir = path.join(root, "home");
    this.#tmpDir = path.join(root, "tmp");
    this.#toolsDir = path.join(root, "tools");
    this.#queue = new PQueue({ concurrency: Math.max(1, opts.maxConcurrency) });
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /**
   * Create the workspace dirs, build the bwrap mount table, and run a trivial
   * command to prove namespaces work on this host. Throws with an actionable
   * message if they don't (missing bwrap, AppArmor userns restriction, …).
   */
  async start(): Promise<void> {
    await mkdir(this.#homeDir, { recursive: true });
    // /tmp is scratch: start every process with an empty one.
    await rm(this.#tmpDir, { recursive: true, force: true });
    await mkdir(this.#tmpDir, { recursive: true });

    this.#baseArgs = await this.#buildBaseArgs();
    this.#running = true;

    const probe = await this.execute("echo sandbox-ok", { timeoutSec: 20 });
    if (probe.exitCode !== 0 || !probe.output.includes("sandbox-ok")) {
      this.#running = false;
      throw new Error(
        `bubblewrap self-test failed (exit ${probe.exitCode}): ${probe.output.trim().slice(0, 500)}. ` +
          "Install bubblewrap and allow it to create user namespaces — see scripts/setup-sandbox.sh.",
      );
    }
    log.info("Local sandbox ready", {
      id: this.id,
      root: path.resolve(this.#opts.rootDir),
      network: this.#opts.network,
      tools: await pathExists(this.#toolsDir),
    });
  }

  async close(): Promise<void> {
    this.#running = false;
    this.#queue.clear();
    for (const child of this.#children) killGroup(child);
    this.#children.clear();
  }

  execute(
    command: string,
    opts: { timeoutSec?: number } = {},
  ): Promise<ExecuteResponse> {
    if (!command || typeof command !== "string") {
      return Promise.resolve({
        output: "Error: Command must be a non-empty string.",
        exitCode: 1,
        truncated: false,
      });
    }
    if (!this.#running) {
      return Promise.resolve({
        output: "Error: sandbox is not running.",
        exitCode: 1,
        truncated: false,
      });
    }
    return this.#queue.add(() =>
      this.#run(command, opts.timeoutSec ?? this.#opts.timeoutSec),
    );
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];
    for (const [sandboxPath, content] of files) {
      results.push({
        path: sandboxPath,
        error: await this.#writeOne(sandboxPath, content),
      });
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const sandboxPath of paths) {
      const resolved = await this.#readOne(sandboxPath);
      results.push(
        "error" in resolved
          ? { path: sandboxPath, content: null, error: resolved.error }
          : { path: sandboxPath, content: resolved.content, error: null },
      );
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // execution
  // ---------------------------------------------------------------------------

  async #buildBaseArgs(): Promise<string[]> {
    const args = [
      "--unshare-all",
      ...(this.#opts.network ? ["--share-net"] : []),
      "--die-with-parent",
      "--hostname", "jarvis-sandbox",
      "--ro-bind", "/usr", "/usr",
    ];
    // /bin, /lib, … are symlinks into /usr on modern distros, real dirs on
    // older ones. Mirror whatever the host has.
    for (const dir of ["/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"]) {
      const st = await lstat(dir).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) args.push("--symlink", await readlink(dir), dir);
      else if (st.isDirectory()) args.push("--ro-bind", dir, dir);
    }
    args.push(
      "--ro-bind", "/etc", "/etc",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/run",
      // systemd-resolved: /etc/resolv.conf is a symlink into here.
      "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve",
      "--bind", this.#homeDir, SANDBOX_HOME,
      "--bind", this.#tmpDir, "/tmp",
    );
    if (await pathExists(this.#toolsDir)) {
      // Same absolute path inside and out so venv shebangs keep working.
      args.push("--ro-bind", this.#toolsDir, this.#toolsDir);
    }
    args.push("--chdir", SANDBOX_HOME);
    return args;
  }

  #childEnv(): Record<string, string> {
    const venvBin = path.join(this.#toolsDir, "venv", "bin");
    const nodeModules = path.join(this.#toolsDir, "node", "node_modules");
    return {
      PATH: [
        venvBin,
        path.join(nodeModules, ".bin"),
        `${SANDBOX_HOME}/.local/bin`,
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
      ].join(":"),
      HOME: SANDBOX_HOME,
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_PATH: nodeModules,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      npm_config_update_notifier: "false",
    };
  }

  #run(command: string, timeoutSec: number): Promise<ExecuteResponse> {
    const maxBytes = this.#opts.maxOutputBytes;
    // Runs inside the sandbox before the agent's command:
    //  - make this process tree the OOM killer's first choice, so a runaway
    //    script dies before the Jarvis server does (they share a cgroup),
    //  - cap single-file size and open fds.
    const fileBlocks = this.#opts.maxFileMb * 1024;
    const prelude =
      "echo 1000 > /proc/self/oom_score_adj 2>/dev/null; " +
      `ulimit -f ${fileBlocks} 2>/dev/null; ulimit -n 4096 2>/dev/null; ` +
      'exec /bin/bash -c "$1"';

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let captured = 0;
      let truncated = false;
      let timedOut = false;

      const child = spawn(
        "bwrap",
        [...this.#baseArgs, "--", "/bin/bash", "-c", prelude, "bash", command],
        {
          env: this.#childEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          // Own process group so a timeout kills the whole tree.
          detached: true,
        },
      );
      this.#children.add(child);

      const onData = (buf: Buffer) => {
        if (captured >= maxBytes) {
          truncated = true;
          return;
        }
        const room = maxBytes - captured;
        if (buf.length > room) {
          chunks.push(buf.subarray(0, room));
          captured = maxBytes;
          truncated = true;
        } else {
          chunks.push(buf);
          captured += buf.length;
        }
      };
      // Interleaved stdout/stderr in arrival order, like a terminal.
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, timeoutSec * 1000);

      const finish = (result: ExecuteResponse) => {
        clearTimeout(timer);
        this.#children.delete(child);
        resolve(result);
      };

      child.on("error", (err) => {
        finish({
          output: `Error: failed to start sandbox (${err.message}). Is bubblewrap installed?`,
          exitCode: 1,
          truncated: false,
        });
      });

      child.on("close", (code, signal) => {
        let output = Buffer.concat(chunks).toString("utf-8");
        if (truncated) {
          output += `\n\n... output truncated at ${maxBytes} bytes`;
        }
        if (timedOut) {
          finish({
            output: `${output}\n\nError: command timed out after ${timeoutSec}s and was killed.`.trimStart(),
            exitCode: 124,
            truncated,
          });
          return;
        }
        if (output.length === 0) output = "<no output>";
        finish({
          output,
          exitCode: code ?? (signal ? 128 : 1),
          truncated,
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // file transfer (host side)
  // ---------------------------------------------------------------------------

  /**
   * Map an absolute sandbox path onto the host. Only the writable mounts are
   * addressable; everything else is `permission_denied`.
   */
  #toHost(
    sandboxPath: string,
  ): { root: string; rel: string[] } | { error: FileOperationError } {
    if (typeof sandboxPath !== "string" || !sandboxPath.startsWith("/")) {
      return { error: "invalid_path" };
    }
    const norm = path.posix.normalize(sandboxPath);
    const mounts: Array<[string, string]> = [
      [SANDBOX_HOME, this.#homeDir],
      ["/tmp", this.#tmpDir],
    ];
    for (const [mountPoint, hostDir] of mounts) {
      if (norm === mountPoint || norm.startsWith(`${mountPoint}/`)) {
        const rel = norm.slice(mountPoint.length).split("/").filter(Boolean);
        return { root: hostDir, rel };
      }
    }
    return { error: "permission_denied" };
  }

  async #writeOne(
    sandboxPath: string,
    content: Uint8Array,
  ): Promise<FileOperationError | null> {
    const mapped = this.#toHost(sandboxPath);
    if ("error" in mapped) return mapped.error;
    if (mapped.rel.length === 0) return "is_directory";

    // Walk the parent chain one component at a time, refusing symlinks, so
    // a link planted by sandboxed code can't redirect a write onto the host.
    let dir = mapped.root;
    for (const part of mapped.rel.slice(0, -1)) {
      dir = path.join(dir, part);
      const st = await lstat(dir).catch(() => null);
      if (!st) {
        try {
          await mkdir(dir);
        } catch (err) {
          if (errCode(err) !== "EEXIST") return mapFsError(err);
        }
      } else if (st.isSymbolicLink() || !st.isDirectory()) {
        return st.isSymbolicLink() ? "permission_denied" : "invalid_path";
      }
    }

    const target = path.join(dir, mapped.rel[mapped.rel.length - 1]!);
    try {
      const handle = await open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_TRUNC |
          fsConstants.O_NOFOLLOW,
        0o644,
      );
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return null;
    } catch (err) {
      // O_NOFOLLOW on a symlink target fails with ELOOP.
      if (errCode(err) === "ELOOP") return "permission_denied";
      return mapFsError(err);
    }
  }

  async #readOne(
    sandboxPath: string,
  ): Promise<{ content: Uint8Array } | { error: FileOperationError }> {
    const mapped = this.#toHost(sandboxPath);
    if ("error" in mapped) return mapped;
    try {
      const rootReal = await realpath(mapped.root);
      const real = await realpath(path.join(mapped.root, ...mapped.rel));
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
        return { error: "permission_denied" };
      }
      const st = await lstat(real);
      if (st.isDirectory()) return { error: "is_directory" };
      return { content: new Uint8Array(await readFile(real)) };
    } catch (err) {
      return { error: mapFsError(err) };
    }
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => null)) !== null;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function mapFsError(err: unknown): FileOperationError {
  switch (errCode(err)) {
    case "ENOENT":
      return "file_not_found";
    case "EISDIR":
      return "is_directory";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    default:
      return "invalid_path";
  }
}
