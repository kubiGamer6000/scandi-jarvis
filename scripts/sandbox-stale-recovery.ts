/**
 * Live smoke test for stale-sandbox recovery.
 *
 * Reproduces the production failure mode (logs say
 * `Connection to the sandbox was already closed` and every `uploadFiles`
 * file fails with the misleading `invalid_path`) and verifies the
 * `getSandbox()` health-probe + auto-re-provision logic recovers.
 *
 * Steps:
 *   1. Provision sandbox A via `getSandbox()`.
 *   2. Sanity-check it (cheap probe + simple execute).
 *   3. Force-close it from under the singleton (manual `.close()`) to
 *      simulate Deno killing a `"session"`-timeout sandbox.
 *   4. Call `getSandbox()` again. The probe should fail, the singleton
 *      should re-provision, and we get sandbox B with a different id.
 *   5. Confirm sandbox B is usable (probe + execute).
 *
 * Run:
 *   npx tsx scripts/sandbox-stale-recovery.ts
 */
import {
  closeSandbox,
  getSandbox,
  isSandboxConfigured,
  isSandboxClosedError,
} from "../src/core/sandbox.js";

async function main() {
  if (!isSandboxConfigured()) {
    console.error("❌  DENO_DEPLOY_TOKEN not set — cannot run.");
    process.exit(1);
  }

  console.log("→ Step 1: getSandbox() — fresh provision");
  const a = await getSandbox();
  if (!a) throw new Error("getSandbox() returned null");
  console.log(`   sandbox A id: ${a.id}`);

  console.log("\n→ Step 2: confirm A works");
  const exec1 = await a.execute("echo healthy");
  console.log(`   execute exit=${exec1.exitCode} output=${exec1.output.trim()}`);
  if (exec1.exitCode !== 0) throw new Error("fresh sandbox not healthy");

  console.log(
    "\n→ Step 3: simulate Deno killing A by closing the connection from under us",
  );
  await a.close();
  console.log("   A closed.");

  // Verify our error classifier recognises closed-connection errors.
  let saw: unknown = null;
  try {
    await a.instance.fs.stat("/");
  } catch (err) {
    saw = err;
  }
  const msg = saw instanceof Error ? saw.message : String(saw);
  console.log(`   probing closed A throws: "${msg}"`);
  console.log(`   isSandboxClosedError() matches? ${isSandboxClosedError(saw)}`);

  console.log("\n→ Step 4: getSandbox() again — should re-provision");
  const b = await getSandbox();
  if (!b) throw new Error("getSandbox() after close returned null");
  console.log(`   sandbox B id: ${b.id}`);
  if (b.id === a.id) {
    throw new Error("expected a NEW sandbox id, got the same one — no recovery");
  }
  console.log("   ✓ ids differ — fresh sandbox was provisioned");

  console.log("\n→ Step 5: confirm B works");
  const exec2 = await b.execute("echo recovered");
  console.log(`   execute exit=${exec2.exitCode} output=${exec2.output.trim()}`);
  if (exec2.exitCode !== 0) throw new Error("recovered sandbox not healthy");

  console.log("\n→ Cleanup");
  await closeSandbox();
  console.log("\n✅ stale-sandbox recovery works");
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
