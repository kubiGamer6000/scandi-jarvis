/**
 * Diagnostic: proves whether the sandbox file-readback path is binary-safe.
 *
 * What it does:
 *   1. Provisions the shared Deno sandbox (one-time cost).
 *   2. Writes a small synthetic "docx-like" payload (ZIP magic + random bytes)
 *      directly via `sandbox.instance.fs.writeFile` (binary-safe).
 *   3. Reads it back THREE ways and reports byte equality + hex prefix:
 *        a) `sandbox.instance.fs.readFile`            — RPC, binary-safe
 *        b) `downloadFiles`                           — cat + UTF-8 round-trip
 *        c) `(sandbox as backend).read(path)`         — what the agent harness
 *                                                       (and `whatsapp_send_file`
 *                                                       BEFORE this fix) uses
 *
 * Expected: (a) is identical; (b) and (c) are corrupted (extra/changed bytes,
 * lots of `ef bf bd` — U+FFFD encoded as UTF-8).
 *
 * Run:
 *   npx tsx scripts/sandbox-binary-readback.ts
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { resolveBackend } from "deepagents";

import { closeSandbox, getSandbox, isSandboxConfigured } from "../src/core/sandbox.js";

const SANDBOX_PATH = "/home/app/diag-binary.bin";

function hexPrefix(buf: Uint8Array, n = 24): string {
  return Array.from(buf.slice(0, n))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function countReplacementChars(buf: Uint8Array): number {
  // U+FFFD encoded in UTF-8 is the 3-byte sequence EF BF BD.
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i += 1) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n += 1;
  }
  return n;
}

async function main() {
  if (!isSandboxConfigured()) {
    console.error("❌  DENO_DEPLOY_TOKEN not set — cannot run sandbox diagnostic.");
    process.exit(1);
  }

  console.log("→ Provisioning sandbox…");
  const sandbox = await getSandbox();
  if (!sandbox) throw new Error("getSandbox() returned null");
  console.log(`   ready: ${sandbox.id}`);

  // ── 1. Build a small binary payload that LOOKS like the start of a docx.
  //    PK\x03\x04 = ZIP local file header. Follow with non-UTF-8 bytes
  //    (random 256 bytes) so we can see where corruption hits.
  const payload = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]), // "PK\x03\x04"
    randomBytes(252),
  ]);
  console.log(`\n→ Writing ${payload.byteLength} bytes via sandbox.fs.writeFile…`);
  await sandbox.instance.fs.writeFile(
    SANDBOX_PATH,
    new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
  );

  // Sanity-check via shell: size + first bytes
  const stat = await sandbox.execute(`stat -c '%s' ${SANDBOX_PATH}`);
  console.log("   stat (size):", stat.output.trim());
  const xxd = await sandbox.execute(`head -c 12 ${SANDBOX_PATH} | xxd`);
  console.log("   xxd head:    ", xxd.output.trim());

  // ── 2a. Read back via the binary-safe SDK call (this is what the fix uses).
  console.log("\n→ (a) sandbox.instance.fs.readFile()");
  const a = Buffer.from(await sandbox.instance.fs.readFile(SANDBOX_PATH));
  console.log("    bytes:", a.byteLength, "  hex[0..24]:", hexPrefix(a));
  console.log("    equal to original?", a.equals(payload));
  console.log("    U+FFFD count:", countReplacementChars(a));

  // ── 2b. Read back via wrapper's `downloadFiles` (cat + UTF-8 round-trip).
  console.log("\n→ (b) sandbox.downloadFiles([path])");
  const dl = await sandbox.downloadFiles([SANDBOX_PATH]);
  const dlContent = dl[0]?.content;
  if (!dlContent) {
    console.log("    (no content / error:", dl[0]?.error, ")");
  } else {
    const b = Buffer.from(dlContent);
    console.log("    bytes:", b.byteLength, "  hex[0..24]:", hexPrefix(b));
    console.log("    equal to original?", b.equals(payload));
    console.log("    U+FFFD count:", countReplacementChars(b));
  }

  // ── 2c. Read back via the deepagents backend.read() — what the OLD
  //         whatsapp_send_file relied on.
  console.log("\n→ (c) resolveBackend(sandbox).read(path)  (the OLD send-file path)");
  // Pass an empty runtime since the Deno backend doesn't use it.
  const resolved = await resolveBackend(sandbox, {} as never);
  const res = await resolved.read(SANDBOX_PATH);
  if (res.error || res.content == null) {
    console.log("    error:", res.error ?? "(no content)");
  } else {
    const raw = res.content;
    const c = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
    console.log(
      "    kind:",
      typeof raw === "string" ? "string" : "Uint8Array",
      "  bytes:",
      c.byteLength,
      "  hex[0..24]:",
      hexPrefix(c),
    );
    console.log("    equal to original?", c.equals(payload));
    console.log("    U+FFFD count:", countReplacementChars(c));
  }

  // Cleanup
  await sandbox.execute(`rm -f ${SANDBOX_PATH}`);
  await closeSandbox();
  console.log("\n✅ done");
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => {});
  process.exit(1);
});
