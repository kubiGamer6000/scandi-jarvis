import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";

import { requirePool } from "../../core/db.js";
import { createLogger } from "../../core/logger.js";

import { readWhatsappContext, type WhatsappContext } from "./runtime-context.js";

const log = createLogger("tools/whatsapp/remember");

const MAX_NOTES_LEN = 20_000;

/**
 * Append or replace a section in the chat's `notes` field. We treat the notes
 * as a single AGENTS.md-style document, with `## <section>` headers. The two
 * modes:
 *
 *   - append (default): always adds a new "Note (<timestamp>): <content>"
 *     entry to the bottom under the existing structure. Idempotency is the
 *     agent's responsibility.
 *
 *   - replace_section: replaces (or creates) a top-level `## <section>`
 *     section verbatim. Use this for stateful facts that supersede prior
 *     versions ("user lives in Sofia", "current target store: scandi-pixel.com").
 */
function applyAppend(existing: string, content: string): string {
  const now = new Date().toISOString();
  const block = `- ${now}: ${content.trim()}`;
  const header = "## Notes";
  if (existing.includes(header)) {
    // Append inside the existing Notes section (at the very end of the doc).
    return `${existing.trimEnd()}\n${block}\n`;
  }
  const sep = existing.trim() ? "\n\n" : "";
  return `${existing.trimEnd()}${sep}${header}\n${block}\n`;
}

function applyReplaceSection(
  existing: string,
  section: string,
  content: string,
): string {
  const slug = section.trim();
  const header = `## ${slug}`;
  const newBlock = `${header}\n${content.trim()}\n`;
  const sectionRe = new RegExp(
    `(^|\\n)## ${escapeRe(slug)}(\\n)([\\s\\S]*?)(?=\\n## |$)`,
    "i",
  );
  if (sectionRe.test(existing)) {
    return existing.replace(sectionRe, (_m, lead) => `${lead}${newBlock}`);
  }
  const sep = existing.trim() ? "\n\n" : "";
  return `${existing.trimEnd()}${sep}${newBlock}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRememberTool(_unused?: void, _opts?: void) {
  // No external dependencies beyond the DB pool (acquired lazily inside).
  return tool(
    async (
      input: {
        content: string;
        mode?: "append" | "replace_section";
        section?: string;
      },
      runtime: ToolRuntime<unknown, WhatsappContext>,
    ) => {
      const ctx = readWhatsappContext(runtime);
      const mode = input.mode ?? "append";
      if (mode === "replace_section" && !input.section?.trim()) {
        return JSON.stringify({
          ok: false,
          error: 'mode="replace_section" requires `section`',
        });
      }
      const pool = requirePool();
      const client = await pool.connect();
      try {
        await client.query("begin");
        const cur = await client.query<{ notes: string }>(
          `insert into jarvis.chat_context (chat_jid, notes, notes_updated_at)
           values ($1, '', now())
           on conflict (chat_jid) do update set chat_jid = excluded.chat_jid
           returning notes`,
          [ctx.chatJid],
        );
        const existing = cur.rows[0]?.notes ?? "";
        const next =
          mode === "append"
            ? applyAppend(existing, input.content)
            : applyReplaceSection(existing, input.section!, input.content);

        if (next.length > MAX_NOTES_LEN) {
          await client.query("rollback");
          return JSON.stringify({
            ok: false,
            error: `notes would exceed ${MAX_NOTES_LEN} chars (current ${existing.length}, would become ${next.length}); use replace_section to trim or send fewer notes`,
          });
        }

        await client.query(
          `update jarvis.chat_context
             set notes = $2, notes_updated_at = now()
           where chat_jid = $1`,
          [ctx.chatJid, next],
        );
        await client.query("commit");

        log.info("wrote note", {
          chat_jid: ctx.chatJid,
          mode,
          section: input.section,
          new_len: next.length,
        });
        return JSON.stringify({
          ok: true,
          mode,
          section: input.section ?? null,
          notes_len: next.length,
        });
      } catch (err) {
        try {
          await client.query("rollback");
        } catch {
          // ignore rollback failure
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn("remember failed", { chat_jid: ctx.chatJid, error: message });
        return JSON.stringify({ ok: false, error: message });
      } finally {
        client.release();
      }
    },
    {
      name: "whatsapp_remember",
      description:
        "Persist a note for THIS chat that will be re-injected into your context on every future run (AGENTS.md-style memory). " +
        "Use this for durable facts that should persist across sessions: who the participants are, ongoing projects, the user's preferences, in-flight todos. " +
        "Modes:\n" +
        "  - append (default): adds a timestamped bullet under a `## Notes` section. Use for chronological observations.\n" +
        "  - replace_section: overwrites (or creates) a top-level `## <section>` block. Use for stateful facts (one canonical answer).",
      schema: z.object({
        content: z
          .string()
          .min(1)
          .max(2000)
          .describe("The text to remember. Concise, durable, agent-readable."),
        mode: z
          .enum(["append", "replace_section"])
          .optional()
          .default("append")
          .describe("How to merge with existing notes."),
        section: z
          .string()
          .optional()
          .describe(
            "When mode=replace_section, the section header to overwrite (without the `## ` prefix). E.g. `User profile`, `Active project`.",
          ),
      }),
    },
  );
}
