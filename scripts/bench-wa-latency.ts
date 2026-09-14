/**
 * Latency benchmark for the WhatsApp agent (real LLM calls, stubbed WhatsApp).
 *
 * Runs a short scripted conversation through the production runner
 * (`runOnce`: context building, session threads, prompt caching, tools)
 * against an in-memory fake of the wa-bot API, for each model config, and
 * prints time-to-first-visible-action (first send/react), total run time,
 * and input / cache-read tokens.
 *
 * Costs real tokens (a few cents per config). Run:
 *   npm run bench:wa                      # default configs
 *   BENCH_CONFIGS=opus5,opus5-fast npm run bench:wa
 *   BENCH_TURNS='["how did we do last week?"]' BENCH_SHOW_REPLIES=1 npm run bench:wa
 */
import { MemorySaver } from "@langchain/langgraph";

import { env } from "../src/core/env.js";
import { closeSandbox } from "../src/core/sandbox.js";
import { buildWhatsappAgent } from "../src/apps/whatsapp/agent.js";
import type { WhatsappClient } from "../src/apps/whatsapp/client.js";
import { runOnce } from "../src/apps/whatsapp/runner.js";
import type { MessagePayload } from "../src/apps/whatsapp/types.js";

interface BenchConfig {
  model: string;
  effort?: "low" | "medium" | "high";
  fast?: boolean;
}

const CONFIGS: Record<string, BenchConfig> = {
  "opus4.6": { model: "anthropic:claude-opus-4-6" },
  opus5: { model: "anthropic:claude-opus-5" },
  "opus5-medium": { model: "anthropic:claude-opus-5", effort: "medium" },
  "opus5-low": { model: "anthropic:claude-opus-5", effort: "low" },
  "opus5-fast": { model: "anthropic:claude-opus-5", fast: true },
};

const TURNS: string[] = process.env.BENCH_TURNS ? JSON.parse(process.env.BENCH_TURNS) : [
  "hey jarvis 👋 quick one: what's 18% of 2,450 EUR?",
  "thanks! and what would the total be including that?",
  "perfect. can you draft a 2-sentence thank-you note to a supplier for fast delivery?",
];

let seqCounter = 1000;
const SELF_JID = "46700000000@s.whatsapp.net";

function fakeClient(chatJid: string, onVisible: () => void): {
  client: WhatsappClient;
  push: (text: string) => MessagePayload;
} {
  const messages: MessagePayload[] = [];
  const mk = (text: string, fromMe: boolean): MessagePayload => ({
    seq: ++seqCounter,
    wa_id: `W${seqCounter}`,
    chat: { jid: chatJid, type: "dm" },
    from: fromMe
      ? { jid: SELF_JID, push_name: "Jarvis" }
      : { jid: chatJid, pn: "+46701234567", push_name: "Veli" },
    from_me: fromMe,
    timestamp: new Date().toISOString(),
    type: "text",
    text,
    mentioned_self: false,
  });
  const client = {
    async getMessage(seq: number) {
      const m = messages.find((x) => x.seq === seq);
      if (!m) throw new Error(`no message ${seq}`);
      return m;
    },
    async fetchMessages(_jid: string, q: { before_seq?: number; after_seq?: number; limit?: number }) {
      let list = messages;
      if (q.before_seq) list = list.filter((m) => m.seq < q.before_seq!);
      if (q.after_seq) list = list.filter((m) => m.seq > q.after_seq!);
      const page = [...list].reverse().slice(0, q.limit ?? 30);
      return { messages: page, ascending: false, next_after_seq: null, next_before_seq: null };
    },
    async send(body: { text?: string }) {
      onVisible();
      if (process.env.BENCH_SHOW_REPLIES) console.log(`   ↳ jarvis: ${body.text}`);
      const m = mk(body.text ?? "", true);
      messages.push(m);
      return { seq: m.seq, wa_id: m.wa_id };
    },
    async react() {
      onVisible();
    },
    async startTyping() {},
    async stopTyping() {},
  };
  return {
    client: client as unknown as WhatsappClient,
    push: (text) => {
      const m = mk(text, false);
      messages.push(m);
      return m;
    },
  };
}

async function benchConfig(name: string, cfg: BenchConfig): Promise<void> {
  const mutableEnv = env as Record<string, unknown>;
  mutableEnv.JARVIS_MODEL = cfg.model;
  mutableEnv.JARVIS_EFFORT = cfg.effort;
  mutableEnv.JARVIS_FAST_MODE = cfg.fast ? "true" : "false";

  const chatJid = `bench-${name}-${Date.now()}@s.whatsapp.net`;
  let firstVisibleAt = 0;
  const { client, push } = fakeClient(chatJid, () => {
    if (!firstVisibleAt) firstVisibleAt = Date.now();
  });
  const agent = await buildWhatsappAgent({ client, checkpointer: new MemorySaver() });

  console.log(`\n=== ${name} (${cfg.model}${cfg.effort ? `, effort=${cfg.effort}` : ""}${cfg.fast ? ", fast" : ""})`);
  for (const [i, text] of TURNS.entries()) {
    const trigger = push(text);
    firstVisibleAt = 0;
    const t0 = Date.now();
    const outcome = await runOnce({ agent, client, chatJid, triggeringSeq: trigger.seq, triggeringMessage: trigger });
    console.log(
      `turn ${i + 1}: first visible ${firstVisibleAt ? `${((firstVisibleAt - t0) / 1000).toFixed(1)}s` : "—"}` +
        ` · total ${(outcome.durationMs / 1000).toFixed(1)}s` +
        ` · calls ${outcome.usage.model_calls} · in ${outcome.usage.input_tokens} (cache read ${outcome.usage.cache_read_tokens}, write ${outcome.usage.cache_write_tokens}) · out ${outcome.usage.output_tokens}` +
        ` · tools ${JSON.stringify(outcome.toolCallCounts)}` +
        (outcome.error ? ` · ERROR ${outcome.error.slice(0, 200)}` : ""),
    );
  }
}

async function main(): Promise<void> {
  mutableEnvForBench();
  const names = (process.env.BENCH_CONFIGS ?? "opus4.6,opus5,opus5-medium,opus5-fast").split(",");
  for (const name of names) {
    const cfg = CONFIGS[name];
    if (!cfg) throw new Error(`unknown config ${name}; known: ${Object.keys(CONFIGS).join(", ")}`);
    await benchConfig(name, cfg);
  }
  await closeSandbox();
  process.exit(0);
}

function mutableEnvForBench(): void {
  const mutableEnv = env as Record<string, unknown>;
  // Keep the benchmark off the production DB and background summaries.
  mutableEnv.SUPABASE_DB_URL = undefined;
  mutableEnv.JARVIS_WA_TYPING_ENABLED = "false";
  mutableEnv.JARVIS_WA_MIN_SEND_INTERVAL_MS = 0;
}

main().catch(async (err) => {
  console.error(err);
  await closeSandbox().catch(() => undefined);
  process.exit(1);
});
