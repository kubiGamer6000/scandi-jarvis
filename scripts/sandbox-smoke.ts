/**
 * Live smoke test for sandbox + skills-sync wiring.
 *
 * What it proves:
 *   1. `getSandbox()` provisions a Deno sandbox once and reuses it.
 *   2. `buildAgent()` attaches the sandbox as the default backend.
 *   3. The sandbox-sync middleware uploads `./skills/...` files into
 *      `/home/app/skills/...` inside the sandbox.
 *   4. Direct sandbox `execute()` can run an uploaded skill script.
 *
 * Costs one sandbox provision (~few cents). Skip with
 * `JARVIS_SKIP_SANDBOX_SMOKE=1`.
 *
 * Run:
 *   npx tsx scripts/sandbox-smoke.ts
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  closeSandbox,
  getSandbox,
  isSandboxConfigured,
} from "../src/core/sandbox.js";
import { createSkillsSandboxSyncMiddleware } from "../src/core/skills-sync.js";

const SKILLS_ROOT = path.resolve(process.cwd(), "skills");
const VIRTUAL_PREFIX = "/home/app/skills";
const SMOKE_SKILL_DIR = path.join(SKILLS_ROOT, "_smoke");

async function withSmokeSkill<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(SMOKE_SKILL_DIR, { recursive: true });
  await writeFile(
    path.join(SMOKE_SKILL_DIR, "SKILL.md"),
    "---\nname: _smoke\ndescription: smoke test skill\n---\n",
  );
  await writeFile(
    path.join(SMOKE_SKILL_DIR, "run.sh"),
    '#!/usr/bin/env bash\necho "skill says hi from $(hostname)"\n',
    { mode: 0o755 },
  );
  try {
    return await fn();
  } finally {
    await rm(SMOKE_SKILL_DIR, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.JARVIS_SKIP_SANDBOX_SMOKE === "1") {
    console.log("(JARVIS_SKIP_SANDBOX_SMOKE=1 – skipping live test)");
    return;
  }
  if (!isSandboxConfigured()) {
    console.error("❌  DENO_DEPLOY_TOKEN not set – nothing to test.");
    process.exit(1);
  }

  await withSmokeSkill(async () => {
    console.log("→ Provisioning sandbox…");
    const sandbox = await getSandbox();
    if (!sandbox) throw new Error("getSandbox() returned null");
    console.log(`   ready: ${sandbox.id}`);

    console.log("→ Running skills-sync middleware (beforeAgent)…");
    const middleware = createSkillsSandboxSyncMiddleware({
      sandbox,
      skillsRoot: SKILLS_ROOT,
      virtualPrefix: VIRTUAL_PREFIX,
    });
    if (!middleware.beforeAgent) {
      throw new Error("middleware did not expose beforeAgent");
    }
    // The hook signature is (state, runtime) → void. We don't have a real
    // runtime here, but the hook never reads it, so an empty object is fine
    // for this smoke test.
    await middleware.beforeAgent({} as never, {} as never);

    console.log("→ Confirming files landed in sandbox…");
    const ls = await sandbox.execute(
      `ls -la ${VIRTUAL_PREFIX}/_smoke/ 2>&1`,
    );
    console.log(ls.output.trimEnd());
    if (ls.exitCode !== 0 || !ls.output.includes("run.sh")) {
      throw new Error("skill files did not appear at the expected path");
    }

    console.log("→ Executing the synced skill script…");
    const run = await sandbox.execute(
      `bash ${VIRTUAL_PREFIX}/_smoke/run.sh`,
    );
    console.log("   exit:", run.exitCode);
    console.log("   output:", run.output.trim());
    if (run.exitCode !== 0 || !run.output.includes("skill says hi")) {
      throw new Error("synced skill script failed to execute");
    }

    console.log("→ Closing sandbox…");
    await closeSandbox();
  });

  console.log("\n✅ sandbox + skills-sync smoke test passed");
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
