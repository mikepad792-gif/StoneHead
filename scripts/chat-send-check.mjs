// scripts/chat-send-check.mjs
// Drives api/chat-send.js end to end: run with  node scripts/chat-send-check.mjs
// (also in `npm run check`).
//
// An in-memory stand-in for Supabase and a stubbed fetch for OpenRouter. No
// network, no database. What it keeps true:
//   1. A crisis or substance turn gets its fixed reply and resource card when
//      the AI service fails: HTTP errors, an empty balance, a throw, a hang.
//   2. An ordinary turn on the same outage still gets the 502.
//   3. Pinned memories reach the chat prompt on an ordinary turn, ahead of
//      the recent summaries, and stay out of a safety turn.
//   4. An unpinned or filter-tripping pin never reaches the prompt.

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.AI_MODEL = "primary/model";
process.env.AI_MODEL_FALLBACK = "fallback/model";
process.env.URL = "https://test.local";
// Small budgets so the hang case finishes fast. Read at module load.
process.env.OPENROUTER_TIMEOUT_CHAT_MS = "400";
process.env.SAFETY_REPLY_DEADLINE_MS = "250";

const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler } = await import("../api/chat-send.js");
const { CRISIS_REPLY } = await import("../lib/crisisDetect.js");
const { SUBSTANCE_REPLY_S1 } = await import("../lib/substanceDetect.js");
const { formatSessionMemoryBlock } = await import("../lib/sessionMemory.js");

const ME = "user-me";
const THREAD = "thread-mine";
const CRISIS_TEXT = "i want to kill myself"; // crisis tier 2, card
const SUBSTANCE_TEXT = "i took like 10 xanax"; // substance tier 1
const ORDINARY_TEXT = "whats a good chill strain for a movie night";
const PIN_TEXT = "Growing their first Blue Dream in a 2x4 tent under a 240W LED.";
const RECENT_TEXT = "Talked through why their sativas feel racy lately.";

// ── In-memory tables and a permissive query builder ─────────────────
let db;
function seed() {
  db = {
    users: [{
      id: ME, daily_message_count: 0, last_message_date: null, is_subscribed: false,
      subscription_expires: null, is_founder: false, age_verified: true, self_reported_age_band: null,
    }],
    threads: [{ id: THREAD, user_id: ME, tab: "vibe", title: "New chat" }],
    messages: [],
    session_memories: [
      { user_id: ME, summary: RECENT_TEXT, frame_tag: "routine", tab: "vibe", created_at: "2026-10-20T00:00:00Z" },
      { user_id: ME, summary: PIN_TEXT, frame_tag: "routine", tab: "plant", created_at: "2026-10-19T00:00:00Z" },
    ],
    core_memories: [
      { user_id: ME, text: PIN_TEXT, pinned: true, status: "active", created_at: "2026-10-21T00:00:00Z" },
      { user_id: ME, text: "An unpinned memory that must stay out.", pinned: false, status: "active", created_at: "2026-10-22T00:00:00Z" },
    ],
  };
}

let nextId = 1;
function query(table) {
  const filters = [];
  let op = "select", payload = null, order = null, limit = null;
  const all = () => db[table] || (db[table] = []);
  const rows = () => all().filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
        id: `row-${nextId++}`, created_at: new Date().toISOString(), ...p,
      }));
      all().push(...list);
      return { data: list, error: null };
    }
    if (op === "update") { rows().forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    if (op === "upsert") { all().push({ ...payload }); return { data: null, error: null }; }
    if (op === "delete") { db[table] = all().filter((r) => !filters.every((f) => f(r))); return { data: null, error: null }; }
    let out = rows().map((r) => ({ ...r }));
    if (order) out.sort((a, b) => (a[order.col] < b[order.col] ? -1 : 1) * (order.asc ? 1 : -1));
    if (limit !== null) out = out.slice(0, limit);
    return { data: out, error: null, count: out.length };
  };
  const b = new Proxy({}, {
    get(_t, prop) {
      switch (prop) {
        case "then": return (res, rej) => Promise.resolve(run()).then(res, rej);
        case "single":
        case "maybeSingle": return async () => ({ data: run().data?.[0] || null, error: null });
        case "eq": return (c, v) => { filters.push((r) => r[c] === v); return b; };
        case "neq": return (c, v) => { filters.push((r) => r[c] !== v); return b; };
        case "in": return (c, vs) => { filters.push((r) => vs.includes(r[c])); return b; };
        case "order": return (col, o = {}) => { order = { col, asc: o.ascending !== false }; return b; };
        case "limit": return (n) => { limit = n; return b; };
        case "insert": return (p) => { op = "insert"; payload = p; return b; };
        case "update": return (p) => { op = "update"; payload = p; return b; };
        case "upsert": return (p) => { op = "upsert"; payload = p; return b; };
        case "delete": return () => { op = "delete"; return b; };
        default: return () => b; // select, is, gte, not, ... : no-op filters
      }
    },
  });
  return b;
}
supabaseAdmin.from = (t) => query(t);
supabaseAdmin.rpc = async () => ({ data: null, error: null });
supabase.auth.getUser = async (token) =>
  token === "me-token"
    ? { data: { user: { id: ME } }, error: null }
    : { data: { user: null }, error: { message: "bad" } };

// ── Stubbed OpenRouter ──────────────────────────────────────────────
// mode: "ok" | "http500" | "http402" | "throw" | "hang"
let mode = "ok";
let modelCalls = [];
// Left in place to the end: nothing in this file may reach the network.
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith(process.env.URL)) return new Response("{}", { status: 202 });
  modelCalls.push(JSON.parse(init.body));
  if (mode === "throw") throw new Error("network down");
  if (mode === "hang") {
    return new Promise((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }
  if (mode === "http500") return new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 500 });
  if (mode === "http402") return new Response(JSON.stringify({ error: { message: "insufficient credits" } }), { status: 402 });
  return new Response(JSON.stringify({
    choices: [{ message: { content: "for real, here's what i got." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

async function send(message, { clientCard = true } = {}) {
  const res = await handler({
    httpMethod: "POST",
    headers: { authorization: "Bearer me-token" },
    body: JSON.stringify({ message, thread_id: THREAD, tab: "vibe", supports_safety_card: clientCard }),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
const systemPrompt = (call) => call.messages.find((m) => m.role === "system").content;

let passed = 0;
const failures = [];
const quiet = ["log", "warn", "error"].map((k) => [k, console[k]]);
async function check(name, fn) {
  seed(); modelCalls = []; mode = "ok";
  quiet.forEach(([k]) => { console[k] = () => {}; });
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
  finally { quiet.forEach(([k, fn]) => { console[k] = fn; }); }
}

// ── 1. Safety turns survive an outage ───────────────────────────────
for (const outage of ["http500", "http402", "throw", "hang"]) {
  await check(`crisis turn + ${outage}: fixed crisis reply and card, not an error`, async () => {
    mode = outage;
    const started = Date.now();
    const { status, body } = await send(CRISIS_TEXT);
    assert.equal(status, 200, `status ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.reply, CRISIS_REPLY);
    assert.ok(body.safetyCard, "no safety card");
    assert.equal(body.rateable, false);
    if (outage === "hang") {
      assert.ok(Date.now() - started < 1500, "hang was not cut off by the deadline");
      // The abandoned request runs on (primary, then fallback timeout). Let
      // it finish here so it can't leak into the next check.
      await new Promise((r) => setTimeout(r, 1000));
    }
    const stored = db.messages.filter((m) => m.thread_id === THREAD).map((m) => m.role);
    assert.deepEqual(stored, ["user", "assistant"], "turn not stored");
  });
}

await check("crisis turn + outage, old client: card text appended to the fixed reply", async () => {
  mode = "http500";
  const { status, body } = await send(CRISIS_TEXT, { clientCard: false });
  assert.equal(status, 200);
  assert.ok(body.reply.startsWith(CRISIS_REPLY));
  assert.ok(body.reply.length > CRISIS_REPLY.length, "card fallback text missing");
});

await check("substance turn + outage: fixed substance reply", async () => {
  mode = "http500";
  const { status, body } = await send(SUBSTANCE_TEXT);
  assert.equal(status, 200);
  assert.equal(body.reply, SUBSTANCE_REPLY_S1);
  assert.ok(body.safetyCard, "no safety card");
});

await check("crisis turn + outage: no blank-retry after a failed request", async () => {
  mode = "http500";
  await send(CRISIS_TEXT);
  // One openrouterChat call = primary + its cross-model fallback. A second
  // callChatModel would make it 4.
  assert.equal(modelCalls.length, 2, `model requests: ${modelCalls.length}`);
});

await check("crisis turn, model up: the model's reply is used", async () => {
  const { status, body } = await send(CRISIS_TEXT);
  assert.equal(status, 200);
  assert.equal(body.reply, "for real, here's what i got.");
  assert.ok(body.safetyCard);
});

// ── 2. Ordinary turns keep the 502 ─────────────────────────────────
for (const outage of ["http500", "throw"]) {
  await check(`ordinary turn + ${outage}: still a 502`, async () => {
    mode = outage;
    const { status, body } = await send(ORDINARY_TEXT);
    assert.equal(status, 502);
    assert.equal(body.error, "AI service unavailable");
    assert.equal(db.messages.length, 0, "a failed ordinary turn stored messages");
  });
}

// ── 3. Pinned memories in the chat prompt ───────────────────────────
await check("ordinary turn: pinned memory reaches the prompt, ahead of recent ones", async () => {
  const { status } = await send(ORDINARY_TEXT);
  assert.equal(status, 200);
  const sp = systemPrompt(modelCalls[0]);
  const pinAt = sp.indexOf(PIN_TEXT);
  assert.ok(pinAt > -1, "pin missing from prompt");
  assert.ok(sp.includes("Pinned by them"), "pin label missing");
  assert.ok(sp.indexOf(RECENT_TEXT) > pinAt, "recent memory should follow the pins");
  assert.equal(sp.split(PIN_TEXT).length - 1, 1, "pinned summary listed twice");
  assert.ok(!sp.includes("An unpinned memory"), "unpinned memory leaked in");
});

await check("crisis turn: no pins, one context-only memory", async () => {
  await send(CRISIS_TEXT);
  const sp = systemPrompt(modelCalls[0]);
  assert.ok(!sp.includes("Pinned by them"), "pins on a crisis turn");
  assert.ok(sp.includes("context only"), "safety memory header missing");
  assert.ok(sp.includes(RECENT_TEXT), "the one memory should still be there");
});

await check("unpinning takes it out on the next turn", async () => {
  db.core_memories[0].pinned = false;
  await send(ORDINARY_TEXT);
  assert.ok(!systemPrompt(modelCalls[0]).includes("Pinned by them"));
});

// ── 4. formatSessionMemoryBlock unit checks ────────────────────────
await check("format: no pins gives exactly the old block", () => {
  const mems = [{ summary: RECENT_TEXT, frame_tag: "routine", tab: "vibe", created_at: new Date().toISOString() }];
  assert.equal(
    formatSessionMemoryBlock(mems, { pinned: [] }),
    formatSessionMemoryBlock(mems),
  );
  assert.equal(formatSessionMemoryBlock(mems), `\n\n[WHAT YOU REMEMBER ABOUT THIS PERSON]\n- today (routine, vibe): ${RECENT_TEXT}`);
  assert.equal(formatSessionMemoryBlock([], {}), "");
});

await check("format: pins alone still make a block", () => {
  const out = formatSessionMemoryBlock([], { pinned: [{ text: PIN_TEXT }] });
  assert.ok(out.includes(PIN_TEXT));
  assert.ok(!out.includes("Recent sessions"));
});

await check("format: a pin that trips the exclusion filter is left out", () => {
  const out = formatSessionMemoryBlock([], { pinned: [{ text: "They are 15 years old and in 10th grade." }] });
  assert.equal(out, "");
});

await check("format: pins capped at 10, each at 400 chars", () => {
  const pins = Array.from({ length: 14 }, (_, i) => ({ text: `pin number ${i} ` + "x".repeat(600) }));
  const out = formatSessionMemoryBlock([], { pinned: pins });
  const pinLines = out.split("\n").filter((l) => l.startsWith("- pin number"));
  assert.equal(pinLines.length, 10);
  assert.ok(pinLines.every((l) => l.length <= 402));
});

await check("format: safety mode drops pins", () => {
  assert.equal(formatSessionMemoryBlock([], { safetyMode: true, pinned: [{ text: PIN_TEXT }] }), "");
});

if (failures.length) {
  console.log(failures.join("\n"));
  console.log(`\nchat-send-check: ${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`chat-send-check: all ${passed} checks passed`);
