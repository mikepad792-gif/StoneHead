// scripts/promo-check.mjs
// Promo code endpoints (v2.1.4): run with  node scripts/promo-check.mjs
// (also in `npm run check`). Stubbed Supabase, no network.
//
// The database half (redeem_promo: stacking, one use per account, founders,
// expired/inactive/used-up codes, the cap under 20 parallel redeems, refund
// of another pass keeping promo days, and the 021-style lockdown) was run
// against real Postgres; see migration 023. This file pins the endpoints:
//   - only the code string comes from the client, normalized
//   - 5 failed tries an hour, checked first, so the 6th is refused even for
//     a real code; success / already_used / founder don't count
//   - every status maps to its message, with no em dashes
//   - preview says valid + days or just valid:false, and limits per IP

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.AI_MODEL ||= "test/model";
process.env.OPENROUTER_API_KEY ||= "test-key";

const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler: redeem } = await import("../api/promo-redeem.js");
const { handler: preview, _resetPreviewLimitForTests, PREVIEWS_PER_HOUR } = await import("../api/promo-preview.js");
const { promoMessage } = await import("../lib/promo.js");

const USER = "user-1";
supabase.auth.getUser = async (t) =>
  t === "good" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad" } };

// ── stubs ───────────────────────────────────────────────────────────
let attempts = 0, inserts = 0, rpcCalls = [], rpcResult = null, codeRow = null;
supabaseAdmin.rpc = async (fn, args) => { rpcCalls.push([fn, args]); return rpcResult; };
supabaseAdmin.from = (table) => {
  const q = {
    select: () => q, eq: () => q,
    gte: async () => ({ count: attempts, error: null }),
    insert: async (row) => { if (table === "promo_attempts") { inserts++; attempts++; assert.equal(row.user_id, USER); } return { error: null }; },
    maybeSingle: async () => ({ data: table === "promo_codes" ? codeRow : null, error: null }),
  };
  return q;
};

const post = (body, token = "good") => ({
  httpMethod: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
});
const get = (code, ip = "1.2.3.4") => ({ httpMethod: "GET", headers: { "x-nf-client-connection-ip": ip }, queryStringParameters: { code } });
const body = (r) => JSON.parse(r.body);

let passed = 0;
const failures = [];
async function check(name, fn) {
  attempts = 0; inserts = 0; rpcCalls = []; rpcResult = { data: { status: "ok", days: 14, subscription_expires: "2026-10-24T12:00:00Z" }, error: null };
  const e = console.error, l = console.log; console.error = () => {}; console.log = () => {};
  try { await fn(); passed++; }
  catch (err) { failures.push(`  FAIL ${name}\n       ${String(err.message).split("\n")[0]}`); }
  finally { console.error = e; console.log = l; }
}

// ── redeem ──────────────────────────────────────────────────────────
await check("redeem: GET is 405, no session is 401", async () => {
  assert.equal((await redeem({ httpMethod: "GET", headers: {} })).statusCode, 405);
  assert.equal((await redeem(post({ code: "STONEHEAD14" }, null))).statusCode, 401);
  assert.equal(rpcCalls.length, 0);
});
await check("redeem: padded lowercase is normalized; only the code goes to the database", async () => {
  const r = await redeem(post({ code: "  stonehead14 ", days: 999, user_id: "someone-else" }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(rpcCalls, [["redeem_promo", { p_user: USER, p_code: "STONEHEAD14" }]]);
});
await check("redeem: success returns the message and new end date, not counted as a try", async () => {
  const b = body(await redeem(post({ code: "STONEHEAD14" })));
  assert.equal(b.status, "ok");
  assert.equal(b.subscription_expires, "2026-10-24T12:00:00Z");
  assert.equal(b.days, 14);
  assert.match(b.message, /^You're in\. 14 free days added\. Your pass now runs through Oct 24, 2026\.$/);
  assert.equal(inserts, 0);
});
for (const bad of ["ab", "x".repeat(33), "STONE-HEAD", "stone head", "<script>", "", 42, null]) {
  await check(`redeem: ${JSON.stringify(bad)} is not_found, counted, never reaches the database`, async () => {
    const b = body(await redeem(post({ code: bad })));
    assert.equal(b.status, "not_found");
    assert.equal(inserts, 1);
    assert.equal(rpcCalls.length, 0);
  });
}
for (const [status, counted] of [["not_found", true], ["not_started", true], ["expired", true], ["used_up", true],
  ["already_used", false], ["founder", false]]) {
  await check(`redeem: ${status} ${counted ? "counts" : "doesn't count"} as a failed try`, async () => {
    rpcResult = { data: { status }, error: null };
    const b = body(await redeem(post({ code: "STONEHEAD14" })));
    assert.equal(b.status, status);
    assert.equal(b.message, promoMessage(status));
    assert.equal(inserts, counted ? 1 : 0);
  });
}
await check("redeem: the 6th try in an hour is too_many even for a real code", async () => {
  rpcResult = { data: { status: "not_found" }, error: null };
  for (let i = 0; i < 5; i++) await redeem(post({ code: "WRONG" + i }));
  rpcResult = { data: { status: "ok", days: 14, subscription_expires: "2026-10-24T12:00:00Z" }, error: null };
  rpcCalls = [];
  const b = body(await redeem(post({ code: "STONEHEAD14" })));
  assert.equal(b.status, "too_many");
  assert.equal(b.message, "Too many tries. Give it an hour.");
  assert.equal(rpcCalls.length, 0);
});
await check("redeem: a database error is a 500 with the try-again message", async () => {
  rpcResult = { data: null, error: { message: "boom" } };
  const r = await redeem(post({ code: "STONEHEAD14" }));
  assert.equal(r.statusCode, 500);
  assert.equal(body(r).message, "Something went wrong. Try again in a minute.");
});
await check("messages: every status has the spec's text and no em or en dashes", async () => {
  const want = {
    already_used: "You've already used this code.",
    not_found: "That code doesn't work. Check the spelling?",
    expired: "That code has expired.",
    not_started: "That code has expired.",
    used_up: "That code's all used up.",
    founder: "You're a founder, so you already have everything. Save the code for a friend.",
    too_many: "Too many tries. Give it an hour.",
    error: "Something went wrong. Try again in a minute.",
  };
  for (const [s, t] of Object.entries(want)) assert.equal(promoMessage(s), t);
  for (const s of [...Object.keys(want), "ok"]) assert.ok(!/[–—]/.test(promoMessage(s, { days: 14, subscription_expires: "2026-10-24" })), s);
});

// ── preview ─────────────────────────────────────────────────────────
const live = { days: 14, active: true, starts_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", uses: 3, max_uses: 100 };
await check("preview: a usable code returns valid + days only", async () => {
  _resetPreviewLimitForTests(); codeRow = live;
  const r = await preview(get(" stonehead14 "));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(body(r), { valid: true, days: 14 });
});
for (const [name, row] of [["missing", null], ["inactive", { ...live, active: false }],
  ["expired", { ...live, expires_at: "2020-01-01T00:00:00Z" }], ["not started", { ...live, starts_at: "2099-01-01T00:00:00Z" }],
  ["used up", { ...live, uses: 100 }]]) {
  await check(`preview: ${name} is just { valid: false }`, async () => {
    _resetPreviewLimitForTests(); codeRow = row;
    assert.deepEqual(body(await preview(get("STONEHEAD14"))), { valid: false });
  });
}
await check("preview: a malformed code is { valid: false } without a lookup", async () => {
  _resetPreviewLimitForTests(); codeRow = live;
  assert.deepEqual(body(await preview(get("no!"))), { valid: false });
});
await check(`preview: the ${PREVIEWS_PER_HOUR + 1}st lookup from one IP in an hour is refused; other IPs aren't`, async () => {
  _resetPreviewLimitForTests(); codeRow = live;
  for (let i = 0; i < PREVIEWS_PER_HOUR; i++) assert.equal((await preview(get("STONEHEAD14", "9.9.9.9"))).statusCode, 200);
  const r = await preview(get("STONEHEAD14", "9.9.9.9"));
  assert.equal(r.statusCode, 429);
  assert.deepEqual(body(r), { valid: false });
  assert.equal((await preview(get("STONEHEAD14", "8.8.8.8"))).statusCode, 200);
});

console.log(`promo check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("All promo checks passed.");
