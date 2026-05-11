import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { extname, join, posix, relative } from "node:path";

import { createMiddleware } from "langchain";

import type { DenoSandbox } from "@langchain/deno";

import { createLogger } from "./logger.js";

const log = createLogger("core/skills-sync");

/**
 * File extensions whose bytes must NOT round-trip through UTF-8.
 *
 * The `@langchain/deno` SDK's `uploadFiles` (as of v0.2.2) decodes every
 * `Uint8Array` via `new TextDecoder().decode(...)` and then writes it via
 * `writeTextFile`. That silently corrupts any file containing bytes that
 * aren't valid UTF-8 – e.g. a 854 KB `.gz` schema becomes a 1.55 MB blob of
 * U+FFFD replacement characters – breaking gunzip with `incorrect header
 * check`.
 *
 * For files with these extensions we bypass `uploadFiles` and write directly
 * via the underlying Deno Sandbox SDK's binary-safe `fs.writeFile`.
 */
const BINARY_EXTENSIONS = new Set([
  // Compressed archives
  ".gz", ".tgz", ".zip", ".tar", ".bz2", ".xz", ".7z", ".zst",
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svgz", ".heic", ".heif", ".avif",
  // Documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // Audio / video
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm", ".ogg", ".flac", ".m4a",
  // Binaries / native modules
  ".wasm", ".bin", ".so", ".dll", ".exe", ".dylib", ".o", ".a", ".class", ".jar",
  // Databases
  ".db", ".sqlite", ".sqlite3",
  // Fonts
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

function isBinary(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Recursively walk a directory and return every regular file path, sorted.
 * Returns an empty list if the directory doesn't exist (e.g. fresh checkout
 * with no skills configured yet).
 */
async function walkFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      if (entry.name === ".gitkeep") continue;
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Translate an on-disk skills file path to its sandbox path.
 *
 *   <skillsRoot>/shopify/foo/SKILL.md   →   <virtualPrefix>/shopify/foo/SKILL.md
 *   <skillsRoot>/shopify/foo/run.sh     →   <virtualPrefix>/shopify/foo/run.sh
 *
 * We deliberately use the same path the agent sees in its virtual filesystem
 * (e.g. `/home/app/skills/...`) so a script the agent reads from `/.../SKILL.md`
 * can be executed at the same path inside the sandbox.
 */
function toSandboxPath(
  skillsRoot: string,
  virtualPrefix: string,
  fullPath: string,
): string {
  const rel = relative(skillsRoot, fullPath);
  return posix.join(virtualPrefix, rel.split("\\").join("/"));
}

/**
 * Write a binary file into the sandbox using the underlying Deno SDK so
 * bytes are preserved verbatim (the wrapper SDK's `uploadFiles` corrupts
 * non-UTF-8 content – see `BINARY_EXTENSIONS`). Auto-creates parent dirs.
 */
async function writeBinary(
  sandbox: DenoSandbox,
  sandboxPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const fs = sandbox.instance.fs;
  const parent = posix.dirname(sandboxPath);
  if (parent && parent !== "/" && parent !== ".") {
    await fs.mkdir(parent, { recursive: true });
  }
  // `writeFile` types want `Uint8Array<ArrayBuffer>`; copy into a fresh
  // ArrayBuffer to satisfy strict typing across realms.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  await fs.writeFile(sandboxPath, new Uint8Array(buf));
}

/**
 * Build a `beforeAgent` middleware that mirrors `<skillsRoot>/...` from the
 * host filesystem into the Deno sandbox at `<virtualPrefix>/...` before each
 * agent invocation.
 *
 * Why we need this:
 *   - the deepagents harness reads `SKILL.md` *metadata* through the backend
 *     route at `<virtualPrefix>/` (a `FilesystemBackend(./skills)` over host
 *     disk), but
 *   - any executable scripts or asset files inside a skill (`run.sh`,
 *     `analyze.py`, `schema.json.gz`, ...) need to be physically present
 *     inside the sandbox so the agent can `bash <virtualPrefix>/foo/run.sh`
 *     via the `execute` tool.
 *
 * We re-upload on every invocation rather than once at build time because:
 *   - the user might edit a skill file mid-session and expect the next run to
 *     pick it up (no need to restart the dev server),
 *   - the per-run cost is small (one batched `uploadFiles` for text files +
 *     a few `fs.writeFile` calls for any binary assets),
 *   - if the sandbox was reset / re-created, this guarantees the files are
 *     there.
 *
 * Text files go through the SDK's batched `uploadFiles` (auto-creates parent
 * dirs). Binary files (`BINARY_EXTENSIONS`) bypass it and write byte-for-byte
 * via the underlying SDK's `fs.writeFile` because the wrapper's text-only
 * upload path corrupts them.
 *
 * If the sandbox isn't `isRunning` for any reason we log and skip uploading
 * rather than failing the whole invocation.
 */
export function createSkillsSandboxSyncMiddleware(opts: {
  sandbox: DenoSandbox;
  skillsRoot: string;
  /**
   * Sandbox path prefix the files should be uploaded under, mirroring the
   * agent's virtual view. Must be writable by the sandbox SDK – on Deno this
   * means under `/home/app/...` or `/tmp/...`, NOT top-level paths like
   * `/skills/...` (those error with `is_directory`).
   */
  virtualPrefix: string;
}) {
  const { sandbox, skillsRoot, virtualPrefix } = opts;

  return createMiddleware({
    name: "JarvisSkillsSandboxSync",
    beforeAgent: async () => {
      if (!sandbox.isRunning) {
        log.warn("Sandbox not running – skipping skills upload");
        return undefined;
      }

      const filePaths = await walkFiles(skillsRoot);
      if (filePaths.length === 0) {
        return undefined;
      }

      const textPayload: Array<[string, Uint8Array]> = [];
      const binaryPayload: Array<[string, Uint8Array]> = [];

      for (const filePath of filePaths) {
        const content = await readFile(filePath);
        const sandboxPath = toSandboxPath(skillsRoot, virtualPrefix, filePath);
        const bytes = new Uint8Array(
          content.buffer,
          content.byteOffset,
          content.byteLength,
        );
        if (isBinary(filePath)) {
          binaryPayload.push([sandboxPath, bytes]);
        } else {
          textPayload.push([sandboxPath, bytes]);
        }
      }

      try {
        if (textPayload.length > 0) {
          const results = await sandbox.uploadFiles(textPayload);
          const failed = results.filter((r) => r.error);
          if (failed.length > 0) {
            log.warn("Some text skill files failed to upload", {
              failed: failed.map((r) => ({ path: r.path, error: r.error })),
            });
          }
        }

        if (binaryPayload.length > 0) {
          await Promise.all(
            binaryPayload.map(([p, bytes]) => writeBinary(sandbox, p, bytes)),
          );
        }

        log.debug("Synced skills into sandbox", {
          textFiles: textPayload.length,
          binaryFiles: binaryPayload.length,
          sandboxId: sandbox.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Skills upload to sandbox failed", { error: message });
      }

      return undefined;
    },
  });
}
