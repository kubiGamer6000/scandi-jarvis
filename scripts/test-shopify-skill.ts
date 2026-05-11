/**
 * End-to-end probe for the shopify-admin skill running inside our Deno
 * sandbox. Skips the LLM entirely — we just provision the sandbox, run the
 * skills-sync middleware to upload `./skills/...`, then call `execute()`
 * directly to verify the skill's scripts actually run there.
 *
 * Run:
 *   npx tsx scripts/test-shopify-skill.ts
 */
import path from "node:path";

import {
  closeSandbox,
  getSandbox,
  isSandboxConfigured,
} from "../src/core/sandbox.js";
import { createSkillsSandboxSyncMiddleware } from "../src/core/skills-sync.js";

const SKILLS_ROOT = path.resolve(process.cwd(), "skills");
const VIRTUAL_PREFIX = "/home/app/skills";
const SKILL_DIR = `${VIRTUAL_PREFIX}/shopify/shopify-admin`;

function header(label: string) {
  console.log("\n" + "=".repeat(60));
  console.log(label);
  console.log("=".repeat(60));
}

function summarise(output: string, maxLines = 20): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines truncated)`].join("\n");
}

async function main() {
  if (!isSandboxConfigured()) {
    console.error("DENO_DEPLOY_TOKEN not set");
    process.exit(1);
  }

  header("1. Provision sandbox");
  const sandbox = await getSandbox();
  if (!sandbox) throw new Error("getSandbox() returned null");
  console.log("   id:", sandbox.id);

  header("2. Probe runtime");
  const probe = await sandbox.execute(
    "echo OS=$(uname -srm); " +
      "echo NODE=$(command -v node && node --version || echo 'NOT INSTALLED'); " +
      "echo BASH=$(command -v bash && bash --version | head -1 || echo 'NOT INSTALLED'); " +
      "echo PWD=$(pwd)",
  );
  console.log(probe.output.trim());
  if (probe.exitCode !== 0) throw new Error("probe failed");

  header("3. Sync ./skills/ into sandbox");
  const middleware = createSkillsSandboxSyncMiddleware({
    sandbox,
    skillsRoot: SKILLS_ROOT,
    virtualPrefix: VIRTUAL_PREFIX,
  });
  if (!middleware.beforeAgent) throw new Error("no beforeAgent");
  const t0 = Date.now();
  await middleware.beforeAgent({} as never, {} as never);
  console.log(`   uploaded in ${Date.now() - t0}ms`);

  header("4. Confirm skill files landed");
  const ls = await sandbox.execute(`ls -la ${SKILL_DIR}/ ${SKILL_DIR}/scripts/ ${SKILL_DIR}/assets/`);
  console.log(ls.output.trim());

  header("5. Run search_docs.mjs (should hit shopify.dev)");
  const search = await sandbox.execute(
    `cd ${SKILL_DIR} && node scripts/search_docs.mjs "productCreate mutation" ` +
      `--model claude-sonnet-4-6 --client-name jarvis-smoke --client-version 0.1.0 2>&1`,
  );
  console.log("   exit:", search.exitCode);
  console.log(summarise(search.output, 30));

  header("6. Run validate.mjs --help (cheap sanity check)");
  const help = await sandbox.execute(
    `cd ${SKILL_DIR} && node scripts/validate.mjs --help 2>&1 || true`,
  );
  console.log("   exit:", help.exitCode);
  console.log(summarise(help.output, 30));

  header("7. Run validate.mjs on a tiny GraphQL query");
  const sampleQuery = `query { products(first: 5) { edges { node { id title totalInventory } } } }`;
  const validate = await sandbox.execute(
    `cd ${SKILL_DIR} && node scripts/validate.mjs ` +
      `--code ${JSON.stringify(sampleQuery)} ` +
      `--model claude-sonnet-4-6 --client-name jarvis-smoke --client-version 0.1.0 ` +
      `--artifact-id smoke-1 --revision 1 2>&1`,
  );
  console.log("   exit:", validate.exitCode);
  console.log(summarise(validate.output, 50));

  header("8. Close sandbox");
  await closeSandbox();
  console.log("\nDone.");
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
