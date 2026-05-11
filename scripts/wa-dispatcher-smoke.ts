/**
 * Pure-logic smoke test for the WA dispatcher pieces that don't need a live
 * WA bot or postgres — `parseCommand`, the transcript formatter, and a
 * scripted state-machine walk-through via a fake agent + client.
 *
 *   npm run smoke:wa-dispatcher
 *
 * Exits non-zero on any assertion failure.
 */
import { setTimeout as delay } from "node:timers/promises";

// IMPORTANT: env vars are read once at import time, so we set the test
// overrides BEFORE any of our modules get imported.
process.env.JARVIS_WA_DEBOUNCE_MS = "50";
process.env.JARVIS_WA_ALLOWED_CHATS = "*";
process.env.WA_BOT_BASE_URL = process.env.WA_BOT_BASE_URL ?? "http://localhost:0";
process.env.WA_BOT_TOKEN = process.env.WA_BOT_TOKEN ?? "test-token";
process.env.WA_WEBHOOK_SECRET = process.env.WA_WEBHOOK_SECRET ?? "test-secret";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key";

const { parseCommand } = await import("../src/apps/whatsapp/commands.js");
const { formatMessageLine } = await import("../src/apps/whatsapp/transcript.js");
type MessagePayload = import("../src/apps/whatsapp/types.js").MessagePayload;

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

/* ---- commands ---- */
section("parseCommand");
assert(parseCommand("/stop").kind === "stop", "/stop");
assert(parseCommand(" /STOP ").kind === "stop", "/STOP (case + whitespace)");
assert(parseCommand("@jarvis /stop").kind === "stop", "@mention /stop");
assert(parseCommand("/halt").kind === "stop", "/halt alias");
assert(parseCommand("/cancel").kind === "stop", "/cancel alias");
assert(parseCommand("stop the build").kind === "none", "no slash → not a command");
assert(parseCommand("").kind === "none", "empty");
assert(parseCommand(null).kind === "none", "null");

/* ---- transcript formatter ---- */
section("formatMessageLine");
const baseMsg = (overrides: Partial<MessagePayload>): MessagePayload => ({
  seq: 1,
  wa_id: "ABC",
  chat: { jid: "123@s.whatsapp.net", type: "dm" },
  from: { jid: "359884430293@s.whatsapp.net", pn: "359884430293", push_name: "Dolan" },
  from_me: false,
  timestamp: "2026-05-11T14:03:00Z",
  type: "text",
  text: "hello",
  mentioned_self: false,
  ...overrides,
});

const l1 = formatMessageLine(baseMsg({ seq: 42 }));
assert(l1.includes("[seq=42"), `transcript header (got: ${l1})`);
assert(l1.includes("Dolan"), "transcript sender push name");
assert(l1.includes("hello"), "transcript body");

const l2 = formatMessageLine(
  baseMsg({
    seq: 43,
    from_me: true,
    text: "copy that",
  }),
);
assert(l2.includes("you:"), "from_me → 'you'");

const l3 = formatMessageLine(
  baseMsg({
    seq: 44,
    text: null,
    media: {
      media_type: "image",
      mime_type: "image/jpeg",
      size_bytes: 12345,
      file_name: "selfie.jpg",
      download_status: "done",
      processed: {
        text: "A person holding a coffee cup.",
        processor: "openai",
        model: "gpt-5",
        completed_at: "2026-05-11T14:04:00Z",
      },
    },
  }),
);
assert(l3.includes("📎 image"), "media kind emoji");
assert(l3.includes("AI summary:"), "media AI summary inlined");

const l4 = formatMessageLine(
  baseMsg({
    seq: 45,
    text: "ok",
    quoted: { seq: 42, message_id: "x", from_jid: "359...", text: "hello" },
  }),
);
assert(l4.includes("↩42"), `quote reference (got: ${l4})`);

const l5 = formatMessageLine(
  baseMsg({
    seq: 46,
    text: null,
    deleted: true,
    deletion_reason: "user_revoked",
  }),
);
assert(l5.includes("🗑"), "tombstone marker");

/* ---- dispatcher state machine ---- */
section("Dispatcher state machine");
const { Dispatcher } = await import("../src/apps/whatsapp/dispatcher.js");

// Fake WA client; we just care about which methods get called.
type Call = { name: string; args: unknown };
const calls: Call[] = [];
const fakeClient = {
  health: async () => ({ status: "ok" }),
  me: async () => ({ pn_jid: "BOT_PN", lid_jid: "BOT_LID" }),
  getMessage: async (seq: number) => ({ seq, media: null }),
  getMedia: async () => ({}),
  downloadMedia: async () => ({ bytes: Buffer.from(""), mimeType: "x", fileName: null }),
  fetchMessages: async () => ({
    chat_jid: "C@s.whatsapp.net",
    count: 0,
    ascending: true,
    next_before_seq: null,
    next_after_seq: null,
    messages: [],
  }),
  send: async (body: unknown) => {
    calls.push({ name: "send", args: body });
    return { seq: 9999, wa_message_id: "x", to: "C@s.whatsapp.net", type: "text" };
  },
  sendMultipart: async () => ({ seq: 9999, wa_message_id: "x", to: "C@s.whatsapp.net", type: "image" }),
  react: async (seq: number, emoji: string) => {
    calls.push({ name: "react", args: { seq, emoji } });
  },
  edit: async () => ({ seq: 0, wa_message_id: "x", edit_wa_message_id: "y" }),
};

// Fake agent.invoke that resolves after `runMs` unless aborted.
const runMs = 300;
let invocations = 0;
const fakeAgent = {
  invoke: async (
    _input: unknown,
    config: { signal?: AbortSignal },
  ): Promise<{ messages: unknown[] }> => {
    invocations += 1;
    const aborted = new Promise<never>((_, reject) => {
      if (config.signal?.aborted) reject(new Error("aborted"));
      config.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
    const done = delay(runMs).then(() => ({
      messages: [
        {
          _getType: () => "ai",
          content: "internal",
          tool_calls: [{ name: "whatsapp_send_message" }],
        },
      ],
    }));
    return Promise.race([done, aborted]);
  },
} as unknown as Parameters<typeof Dispatcher>[0]["agent"];

const dispatcher = new Dispatcher({
  agent: fakeAgent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: fakeClient as any,
  self: { pnJid: "BOT_PN", lidJid: "BOT_LID", accountId: "acc1" },
});

const makeMsg = (seq: number, overrides: Partial<MessagePayload> = {}): MessagePayload =>
  baseMsg({ seq, chat: { jid: "C@s.whatsapp.net", type: "dm" }, ...overrides });

// Scenario A: single message — should debounce, run once.
calls.length = 0;
invocations = 0;
dispatcher.ingest({ message: makeMsg(101) });
// debounce 50ms + buildContext + Supabase round-trip can take a while in real env.
// Poll up to 2s for the first invoke.
for (let i = 0; i < 40 && invocations === 0; i++) await delay(50);
assert(invocations === 1, `single-message: invoked once (got ${invocations})`);
await delay(400); // let the 300ms agent run finish

// Scenario B: hard interrupt — second message during run aborts + restarts
calls.length = 0;
invocations = 0;
dispatcher.ingest({ message: makeMsg(201) });
for (let i = 0; i < 40 && invocations === 0; i++) await delay(50);
const beforeInterruptInvocations = invocations;
dispatcher.ingest({ message: makeMsg(202) });
await delay(100); // abort + new debounce fires
assert(
  calls.some((c) => c.name === "react" && (c.args as { emoji: string }).emoji === "🔄"),
  "hard-interrupt: 🔄 react sent on the new message",
);
for (let i = 0; i < 40 && invocations <= beforeInterruptInvocations; i++) {
  await delay(50);
}
assert(
  invocations > beforeInterruptInvocations,
  `hard-interrupt: agent restarted after abort (invocations went ${beforeInterruptInvocations} → ${invocations})`,
);
await delay(400);

// Scenario C: /stop intercepts before agent
calls.length = 0;
invocations = 0;
dispatcher.ingest({ message: makeMsg(301) });
await delay(80); // partway into debounce; doesn't matter if invoke fired or not
dispatcher.ingest({ message: makeMsg(302, { text: "/stop" }) });
// /stop sends the message synchronously, but the await chains take a tick.
for (let i = 0; i < 40; i++) {
  if (
    calls.some(
      (c) =>
        c.name === "send" &&
        (c.args as { text: string }).text.toLowerCase().includes("stopped"),
    )
  ) {
    break;
  }
  await delay(50);
}
assert(
  calls.some(
    (c) =>
      c.name === "send" &&
      (c.args as { text: string }).text.toLowerCase().includes("stopped"),
  ),
  "/stop: 'I've stopped' message sent directly",
);
assert(
  calls.some((c) => c.name === "react" && (c.args as { emoji: string }).emoji === "🛑"),
  "/stop: 🛑 react sent on stop trigger",
);

// Scenario D: loop protection — message from the bot's own pn/lid is dropped.
// Wait for any prior runs to fully settle first so we don't conflate them.
await delay(800);
calls.length = 0;
invocations = 0;
dispatcher.ingest({
  message: makeMsg(401, {
    from: { jid: "BOT_PN", push_name: "Jarvis" },
    from_me: false,
  }),
});
await delay(300);
assert(
  invocations === 0,
  `loop-protection: bot's own pn was filtered (invocations: ${invocations})`,
);

await dispatcher.drain();

section("Summary");
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nall good.");
process.exit(0);
