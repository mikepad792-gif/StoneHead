// scripts/feedback-check.mjs
// Thumbs up / down on replies: run with  node scripts/feedback-check.mjs
// (also in `npm run check`).
//
// Drives api/feedback.js against an in-memory stand-in for Supabase, and pins
// lib/feedbackEligibility.js. No network, no database. What it keeps true:
//   1. Only your own StoneHead replies can be rated.
//   2. A safety turn can never be rated, even by a hand-built request.
//   3. Up means training_ok; down never does, and switching flips it.
//   4. The comment never reaches the logs.

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";

const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler, MAX_COMMENT } = await import("../api/feedback.js");
const { rateableReplyIds, isSafetyTurn } = await import("../lib/feedbackEligibility.js");
const { UNDER_13_REPLY } = await import("../lib/ageDetect.js");
const { APP_VERSION } = await import("../src/version.js");

const ME = "user-me", THEM = "user-them";
const CRISIS_TEXT = "i dont want to be here anymore"; // crisis tier 1, no card
const SUBSTANCE_TEXT = "i took like 10 xanax";         // substance tier 1

// ── In-memory tables and a tiny query builder ───────────────────────
let db;
function seed() {
  db = {
    users: [{ id: ME, skip_training_prompt: false }, { id: THEM, skip_training_prompt: false }],
    threads: [{ id: "t-mine", user_id: ME }, { id: "t-theirs", user_id: THEM }],
    messages: [
      { id: "m1", thread_id: "t-mine", role: "user", content: "what strain helps with sleep", created_at: "2026-01-01T00:00:01Z" },
      { id: "r1", thread_id: "t-mine", role: "assistant", content: "granddaddy purple, easy.", created_at: "2026-01-01T00:00:02Z" },
      { id: "m2", thread_id: "t-mine", role: "user", content: CRISIS_TEXT, created_at: "2026-01-01T00:00:03Z" },
      { id: "r2", thread_id: "t-mine", role: "assistant", content: "hey, i'm here. what's going on?", created_at: "2026-01-01T00:00:04Z" },
      { id: "m3", thread_id: "t-mine", role: "user", content: SUBSTANCE_TEXT, created_at: "2026-01-01T00:00:05Z" },
      { id: "r3", thread_id: "t-mine", role: "assistant", content: "ok, let's slow down.", created_at: "2026-01-01T00:00:06Z" },
      { id: "m4", thread_id: "t-mine", role: "user", content: "ok thanks, back to strains", created_at: "2026-01-01T00:00:07Z" },
      { id: "r4", thread_id: "t-mine", role: "assistant", content: "bet. what vibe you after?", created_at: "2026-01-01T00:00:08Z" },
      { id: "x1", thread_id: "t-theirs", role: "user", content: "hi", created_at: "2026-01-01T00:00:01Z" },
      { id: "xr1", thread_id: "t-theirs", role: "assistant", content: "yo", created_at: "2026-01-01T00:00:02Z" },
    ],
    message_feedback: [],
  };
}

function query(table) {
  const filters = [];
  let op = "select", payload = null, conflict = null, order = null;
  const rows = () => db[table].filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === "select") {
      let out = rows().map((r) => ({ ...r }));
      if (order) out.sort((a, b) => (a[order.col] < b[order.col] ? -1 : 1) * (order.asc ? 1 : -1));
      return { data: out, error: null };
    }
    if (op === "delete") { db[table] = db[table].filter((r) => !filters.every((f) => f(r))); return { data: null, error: null }; }
    if (op === "update") { rows().forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
    if (op === "upsert") {
      const keys = conflict.split(",");
      const hit = db[table].find((r) => keys.every((k) => r[k] === payload[k]));
      if (hit) Object.assign(hit, payload);
      else db[table].push({ created_at: new Date().toISOString(), ...payload });
      return { data: null, error: null };
    }
  };
  const b = {
    select: () => b,
    eq: (c, v) => { filters.push((r) => r[c] === v); return b; },
    not: (c, _is, v) => { filters.push((r) => r[c] !== v); return b; },
    order: (col, o = {}) => { order = { col, asc: o.ascending !== false }; return b; },
    delete: () => { op = "delete"; return b; },
    update: (p) => { op = "update"; payload = p; return b; },
    upsert: (p, o) => { op = "upsert"; payload = p; conflict = o.onConflict; return b; },
    maybeSingle: async () => ({ data: run().data?.[0] || null, error: null }),
    single: async () => ({ data: run().data?.[0] || null, error: null }),
    then: (res, rej) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}
supabaseAdmin.from = (t) => query(t);
supabase.auth.getUser = async (token) =>
  token === "me-token"
    ? { data: { user: { id: ME } }, error: null }
    : { data: { user: null }, error: { message: "bad" } };

let logs = [];
const realLog = console.log, realErr = console.error;
async function call(body, { token = "me-token" } = {}) {
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  try {
    return await handler({
      httpMethod: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });
  } finally { console.log = realLog; console.error = realErr; }
}
const row = (id) => db.message_feedback.find((f) => f.user_id === ME && f.message_id === id);
const me = () => db.users.find((u) => u.id === ME);

let passed = 0;
const failures = [];
async function check(name, fn) {
  seed(); logs = [];
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}

// ── Eligibility (the rule shared with chat-send and threads-messages) ─
await check("eligibility: the test phrases really are safety turns", () => {
  assert.equal(isSafetyTurn(CRISIS_TEXT), true);
  assert.equal(isSafetyTurn(SUBSTANCE_TEXT), true);
  assert.equal(isSafetyTurn("what strain helps with sleep"), false);
});
await check("eligibility: ordinary replies yes, safety and under-13 replies no", () => {
  seed();
  const ids = rateableReplyIds([
    ...db.messages.filter((m) => m.thread_id === "t-mine"),
    { id: "m5", role: "user", content: "i'm 12" },
    { id: "r5", role: "assistant", content: UNDER_13_REPLY },
  ]);
  assert.deepEqual([...ids].sort(), ["r1", "r4"]);
});

// ── Endpoint ──────────────────────────────────────────────────────────
await check("no session: 401", async () => {
  assert.equal((await call({ message_id: "r1", rating: "up" }, { token: null })).statusCode, 401);
  assert.equal(db.message_feedback.length, 0);
});
await check("someone else's reply: 404", async () => {
  assert.equal((await call({ message_id: "xr1", rating: "up" })).statusCode, 404);
});
await check("a user message: 404", async () => {
  assert.equal((await call({ message_id: "m1", rating: "up" })).statusCode, 404);
});
await check("unknown message: 404", async () => {
  assert.equal((await call({ message_id: "nope", rating: "up" })).statusCode, 404);
});
await check("reply to a crisis message: 409, nothing saved", async () => {
  assert.equal((await call({ message_id: "r2", rating: "down", comment: "x" })).statusCode, 409);
  assert.equal(db.message_feedback.length, 0);
});
await check("reply to a substance message: 409, nothing saved", async () => {
  assert.equal((await call({ message_id: "r3", rating: "up" })).statusCode, 409);
  assert.equal(db.message_feedback.length, 0);
});
await check("bad rating value: 400", async () => {
  assert.equal((await call({ message_id: "r1", rating: "meh" })).statusCode, 400);
});
await check("up saves training_ok = true with the optional comment", async () => {
  const r = await call({ message_id: "r1", rating: "up", comment: "  perfect answer  " });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { success: true, rating: "up" });
  assert.equal(row("r1").rating, "up");
  assert.equal(row("r1").training_ok, true);
  assert.equal(row("r1").comment, "perfect answer");
  assert.equal(row("r1").thread_id, "t-mine");
});
await check("a bare thumbs-up (no comment) saves", async () => {
  assert.equal((await call({ message_id: "r1", rating: "up" })).statusCode, 200);
  assert.equal(row("r1").comment, null);
});
await check("switching down (with comment) to a bare up clears the old comment", async () => {
  await call({ message_id: "r1", rating: "down", comment: "bad" });
  await call({ message_id: "r1", rating: "up" });
  assert.equal(row("r1").comment, null);
  assert.equal(row("r1").training_ok, true);
});
await check(`${MAX_COMMENT + 1}-character comment on an up: 400, nothing saved`, async () => {
  assert.equal((await call({ message_id: "r1", rating: "up", comment: "x".repeat(MAX_COMMENT + 1) })).statusCode, 400);
  assert.equal(db.message_feedback.length, 0);
});
await check("down saves the trimmed comment with training_ok = false", async () => {
  await call({ message_id: "r4", rating: "down", comment: "  too long winded  " });
  assert.equal(row("r4").rating, "down");
  assert.equal(row("r4").comment, "too long winded");
  assert.equal(row("r4").training_ok, false);
});
await check("a rating carries the app version it was made on", async () => {
  await call({ message_id: "r1", rating: "up" });
  assert.equal(row("r1").app_version, APP_VERSION);
  await call({ message_id: "r1", rating: "down" });
  assert.equal(row("r1").app_version, APP_VERSION);
});
await check("a bare thumbs-down (no comment) saves", async () => {
  assert.equal((await call({ message_id: "r4", rating: "down" })).statusCode, 200);
  assert.equal(row("r4").comment, null);
});
await check("up then down replaces the row and flips training_ok", async () => {
  await call({ message_id: "r1", rating: "up" });
  await call({ message_id: "r1", rating: "down", comment: "changed my mind" });
  assert.equal(db.message_feedback.filter((f) => f.message_id === "r1").length, 1);
  assert.equal(row("r1").rating, "down");
  assert.equal(row("r1").training_ok, false);
});
await check("rating: null deletes", async () => {
  await call({ message_id: "r1", rating: "up" });
  const r = await call({ message_id: "r1", rating: null });
  assert.equal(r.statusCode, 200);
  assert.equal(row("r1"), undefined);
});
await check("dont_ask_again sets the user flag on an up", async () => {
  await call({ message_id: "r1", rating: "up", dont_ask_again: true });
  assert.equal(me().skip_training_prompt, true);
});
await check("dont_ask_again does nothing on a down", async () => {
  await call({ message_id: "r1", rating: "down", dont_ask_again: true });
  assert.equal(me().skip_training_prompt, false);
});
await check(`${MAX_COMMENT + 1}-character comment: 400, nothing saved`, async () => {
  assert.equal((await call({ message_id: "r1", rating: "down", comment: "x".repeat(MAX_COMMENT + 1) })).statusCode, 400);
  assert.equal(db.message_feedback.length, 0);
});
await check(`${MAX_COMMENT}-character comment: saved`, async () => {
  assert.equal((await call({ message_id: "r1", rating: "down", comment: "y".repeat(MAX_COMMENT) })).statusCode, 200);
});
await check("the log line never contains the comment", async () => {
  await call({ message_id: "r1", rating: "down", comment: "secret-comment-text" });
  await call({ message_id: "r4", rating: "up", comment: "secret-comment-text" });
  const all = logs.join("\n");
  assert.ok(all.includes('"event":"feedback"'), "missing event log");
  assert.ok(!all.includes("secret-comment-text"), "comment leaked into logs");
});

// ── Report ──────────────────────────────────────────────────────────
if (failures.length) console.log(failures.join("\n"));
console.log(`\nfeedback check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.error("\nReply feedback is NOT safe to ship. Do not deploy.");
  process.exit(1);
}
console.log("All feedback checks passed.");
