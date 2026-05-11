/**
 * Diagnostic: replicate `buildAgent`'s backend topology and call exactly
 * the same FS APIs the deepagents `SkillsMiddleware` uses, so we can see
 * whether the subagent could discover the shopify-admin skill.
 *
 * Run:
 *   npx tsx scripts/probe-skills-backend.ts
 */
import path from "node:path";

import {
  CompositeBackend,
  FilesystemBackend,
  adaptBackendProtocol,
  parseSkillMetadata,
  type AnyBackendProtocol,
} from "deepagents";

import { closeSandbox, getSandbox, isSandboxConfigured } from "../src/core/sandbox.js";

const SKILLS_ROOT = path.resolve(process.cwd(), "skills");
const SKILLS_VIRTUAL_PREFIX = "/home/app/skills";

async function main() {
  const sandbox = isSandboxConfigured() ? await getSandbox() : null;
  if (!sandbox) {
    console.error("DENO_DEPLOY_TOKEN not set – falling back to fs-only backend");
  }

  const skillsRouteKey = `${SKILLS_VIRTUAL_PREFIX}/`;
  const fsBackend = new FilesystemBackend({ rootDir: SKILLS_ROOT, virtualMode: true });
  const backend: AnyBackendProtocol = sandbox
    ? new CompositeBackend(sandbox, { [skillsRouteKey]: fsBackend })
    : fsBackend;

  const adapted = adaptBackendProtocol(backend);

  const sourcePath = `${SKILLS_VIRTUAL_PREFIX}/shopify/`;
  console.log(`\nls(${sourcePath}):`);
  const ls = await adapted.ls(sourcePath);
  console.log(JSON.stringify(ls, null, 2));

  console.log(`\nFor each subdirectory, try to read SKILL.md:`);
  for (const f of ls.files ?? []) {
    if (!f.is_dir) continue;
    const name = f.path.replace(/[/\\]$/, "").split(/[/\\]/).pop() ?? "";
    const skillMd = `${sourcePath}${name}/SKILL.md`;
    console.log(`\n  → ${skillMd}`);
    const r = await adapted.read(skillMd);
    if (r.error) {
      console.log(`    READ ERROR: ${r.error}`);
      continue;
    }
    const content =
      typeof r.content === "string" ? r.content : new TextDecoder().decode(r.content as Uint8Array);
    console.log(`    bytes: ${content.length}`);
    const meta = parseSkillMetadata(content, skillMd, name);
    if (meta) {
      console.log(`    parsed metadata:`);
      console.log(`      name: ${meta.name}`);
      console.log(`      description: ${meta.description?.slice(0, 120)}…`);
    } else {
      console.log(`    parseSkillMetadata returned null`);
    }
  }

  await closeSandbox();
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
