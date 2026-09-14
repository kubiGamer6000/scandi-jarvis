/**
 * Smoke test for the sandbox (no LLM calls).
 *
 * Checks, against whichever provider JARVIS_SANDBOX_PROVIDER selects:
 *   1. the sandbox starts and runs shell commands,
 *   2. binary files round-trip byte-for-byte (upload → execute → download),
 *   3. skills sync lands scripts where `execute` can run them,
 *   4. (local provider) isolation: no Jarvis env vars, no host processes,
 *      no /opt, symlinks can't be used to read or write outside the sandbox,
 *      and runaway commands are killed at the timeout.
 *
 * Run:
 *   npm run smoke:sandbox
 */
import { randomBytes } from "node:crypto";
import path from "node:path";

import { env } from "../src/core/env.js";
import { closeSandbox, getSandbox } from "../src/core/sandbox.js";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log("   ", detail);
  }
}

async function main(): Promise<void> {
  const sandbox = await getSandbox();
  if (!sandbox) {
    console.error("getSandbox() returned null – see the log above for why.");
    process.exit(1);
  }
  console.log(`sandbox: ${sandbox.describe()}\n`);

  const echo = await sandbox.execute("echo hello");
  check("execute runs shell commands", echo.exitCode === 0 && echo.output.includes("hello"), echo);
  const tools = await sandbox.execute(
    "for t in python3 node npm pdftotext qpdf pandoc tesseract soffice; do printf '%-10s %s\\n' $t \"$(command -v $t || echo MISSING)\"; done; python3 -c 'import pypdf, pdfplumber, reportlab, docx; print(\"python libs ok\")' 2>&1 | tail -1",
  );
  console.log(`   toolchain:\n${tools.output.replace(/^/gm, "     ")}`);

  const failing = await sandbox.execute("exit 7");
  check("exit codes propagate", failing.exitCode === 7, failing);

  // Binary round-trip, including every byte value.
  const bytes = new Uint8Array(randomBytes(64_000));
  bytes.set(Array.from({ length: 256 }, (_, i) => i), 0);
  const [up] = await sandbox.uploadFiles([["/home/app/smoke/blob.bin", bytes]]);
  check("upload binary", up?.error === null, up);
  const copy = await sandbox.execute("cp /home/app/smoke/blob.bin /tmp/blob-copy.bin && sha256sum /home/app/smoke/blob.bin /tmp/blob-copy.bin");
  const [down] = await sandbox.downloadFiles(["/tmp/blob-copy.bin"]);
  check(
    "binary round-trips byte-for-byte through execute",
    copy.exitCode === 0 && down?.content !== null && Buffer.compare(Buffer.from(down!.content!), Buffer.from(bytes)) === 0,
    { copy, error: down?.error },
  );

  // deepagents' shell-based file ops on top of execute/upload/download.
  const write = await sandbox.write("/home/app/smoke/notes.txt", "line one\nline two\n");
  const read = await sandbox.read("/home/app/smoke/notes.txt");
  check("write + read via BaseSandbox", !write.error && !read.error, { write, read });

  // Skills sync + running a skill script.
  await sandbox.syncDirectory(path.resolve("skills"), "/home/app/skills");
  await sandbox.syncDirectory(path.resolve("kit"), "/home/app/kit");
  const skill = await sandbox.execute("ls /home/app/skills/jarvis/shopify-admin/scripts /home/app/kit/lib");
  check(
    "skills + kit synced into the sandbox",
    skill.output.includes("validate.mjs") && skill.output.includes("profitApi.ts"),
    skill,
  );
  const exec = await sandbox.execute("test -x /home/app/skills/jarvis/shopify-admin/scripts/validate.mjs && echo exec-ok");
  check("skill scripts are executable", exec.output.includes("exec-ok"), exec);

  if (process.env.KIT_SMOKE !== "0") {
    const kit = await sandbox.execute(
      "cd /home/app/workspace && tsx /home/app/skills/jarvis/scandi-profit-api/scripts/profit.ts health 2>&1 | tail -3",
    );
    check(
      "kit script reaches the Profit API through the gateway (set KIT_SMOKE=0 to skip)",
      kit.exitCode === 0 && !/error|not available|not configured/i.test(kit.output),
      kit,
    );
  }

  const missing = await sandbox.downloadFiles(["/home/app/does/not/exist"]);
  check("missing file → file_not_found", missing[0]?.error === "file_not_found", missing);

  if (sandbox.id.startsWith("local-")) {
    console.log("\nisolation (local provider)");

    const envDump = await sandbox.execute("env");
    check(
      "no Jarvis secrets in the environment",
      !/ANTHROPIC|SUPABASE|WA_BOT|TAVILY|COMPOSIO|DENO|SECRET|API_KEY|APP_TOKEN|CLIENT_ID/.test(envDump.output),
      envDump.output,
    );

    const procs = await sandbox.execute("ls /proc | grep -E '^[0-9]+$' | wc -l");
    check("own pid namespace (host processes invisible)", Number(procs.output.trim()) < 10, procs);

    const opt = await sandbox.execute(`ls ${JSON.stringify(process.cwd())} 2>&1; ls /opt 2>&1; cat /proc/1/environ 2>&1 | tr '\\0' '\\n' | grep -c ANTHROPIC`);
    check("host repo and /opt are not mounted", !opt.output.includes("package.json"), opt);

    const ro = await sandbox.execute("touch /usr/pwned 2>&1; echo rc=$?");
    check("system dirs are read-only", ro.output.includes("rc=1"), ro);

    const envFile = path.resolve(".env");
    await sandbox.execute(`ln -sfn ${JSON.stringify(envFile)} /home/app/smoke/env-link; ln -sfn ${JSON.stringify(process.cwd())} /home/app/smoke/repo-link`);
    const [leak] = await sandbox.downloadFiles(["/home/app/smoke/env-link"]);
    check("symlink cannot read host files", leak?.content === null, leak);
    const [escape] = await sandbox.uploadFiles([["/home/app/smoke/repo-link/PWNED.txt", new TextEncoder().encode("x")]]);
    check("symlinked dir cannot redirect writes", escape?.error === "permission_denied", escape);
    const [overwrite] = await sandbox.uploadFiles([["/home/app/smoke/env-link", new TextEncoder().encode("x")]]);
    check("symlinked file cannot redirect writes", overwrite?.error === "permission_denied", overwrite);
    const [outside] = await sandbox.downloadFiles(["/etc/passwd"]);
    check("paths outside /home/app and /tmp are refused", outside?.error === "permission_denied", outside);

    if (env.JARVIS_SANDBOX_EXEC_TIMEOUT_SEC <= 10) {
      const t0 = Date.now();
      const slow = await sandbox.execute("sleep 600 & sleep 600; echo never");
      check("timeout kills the process tree", slow.exitCode === 124 && Date.now() - t0 < 20_000, slow);
    } else {
      console.log("   (set JARVIS_SANDBOX_EXEC_TIMEOUT_SEC=5 to also test timeouts)");
    }
  }

  await sandbox.execute("rm -rf /home/app/smoke");
  await closeSandbox();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => undefined);
  process.exit(1);
});
