// scripts/passes-check.mjs
// Passes and photo quota endpoints: run with  node scripts/passes-check.mjs
// (also in `npm run check`). Stubbed Stripe and Supabase, no network.
//
// The database half (grant_pass stacking and idempotency, claim/release,
// settle, thread deletes not refunding photos) runs against real Postgres;
// see migration 019. This file pins the endpoints around it:
//   - checkout/create only sells what the server's PASSES map knows
//   - the webhook trusts nothing it can't verify and grants from the map
//   - photo-read asks before spending rollover, and refunds failed reads

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.AI_MODEL ||= "test/model";
process.env.OPENROUTER_API_KEY ||= "test-key";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
process.env.STRIPE_PRICE_7DAY = "price_7";
process.env.STRIPE_PRICE_30DAY = "price_30";

const { default: Stripe } = await import("stripe");
const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { setStripeForTests } = await import("../lib/stripe.js");
const { handler: checkout } = await import("../api/checkout-create.js");
const { handler: webhook } = await import("../api/stripe-webhook.js");
const { handler: photoRead } = await import("../api/plant-photo-read.js");
const { handler: settings } = await import("../api/profile-settings.js");
const { PHOTO_DAILY_LIMIT, PHOTO_DAILY_LIMIT_UNLIMITED } = await import("../lib/config.js");

const USER = "user-1";
supabase.auth.getUser = async (t) =>
  t === "good" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad" } };

let logs = [];
const quiet = async (fn) => {
  const l = console.log, e = console.error, w = console.warn;
  console.log = console.error = console.warn = (...a) => logs.push(a.join(" "));
  try { return await fn(); } finally { console.log = l; console.error = e; console.warn = w; }
};
const req = (body, { token = "good", headers = {}, raw } = {}) => ({
  httpMethod: "POST",
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  body: raw ?? JSON.stringify(body),
});

let passed = 0;
const failures = [];
async function check(name, fn) {
  logs = [];
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}

// ── checkout/create ─────────────────────────────────────────────────
let sessionArgs = null;
const realStripe = new Stripe("sk_test_fake");
setStripeForTests({
  checkout: { sessions: { create: async (a) => { sessionArgs = a; return { url: "https://checkout.stripe.test/s" }; } } },
  webhooks: realStripe.webhooks, // real signature verification
});

// Refund cooldown lookups (lib/passStatus.js refundCooldownUntil).
let refundRows = [], refundErr = null, internal = false, refundFilter = null;
supabaseAdmin.from = (table) => {
  const q = {
    select: () => q, eq: () => q, order: () => q,
    gt: (col, v) => { refundFilter = [col, v]; return q; },
    limit: async () => ({ data: refundRows, error: refundErr }),
    maybeSingle: async () => ({ data: table === "users" ? { is_internal: internal } : null, error: null }),
  };
  return q;
};
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

await check("checkout: no session is 401", async () => {
  assert.equal((await checkout(req({ pass: "7day" }, { token: null }))).statusCode, 401);
});
for (const bad of [{}, { pass: "90day" }, { pass: "__proto__" }, { pass: 7 }, { pass: "7day ", days: 365 }]) {
  await check(`checkout: pass ${JSON.stringify(bad)} is 400`, async () => {
    sessionArgs = null;
    assert.equal((await checkout(req(bad))).statusCode, 400);
    assert.equal(sessionArgs, null);
  });
}
await check("checkout: 7day uses the 7-day Price and tags the user", async () => {
  const r = await checkout(req({ pass: "7day", price: "price_cheap", days: 999 }));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).url, "https://checkout.stripe.test/s");
  assert.equal(sessionArgs.mode, "payment");
  assert.deepEqual(sessionArgs.line_items, [{ price: "price_7", quantity: 1 }]);
  assert.equal(sessionArgs.client_reference_id, USER);
  assert.deepEqual(sessionArgs.metadata, { user_id: USER, pass: "7day" });
  assert.match(sessionArgs.success_url, /\/\?paid=1$/);
  assert.match(sessionArgs.cancel_url, /\/\?paid=0$/);
});
await check("checkout: 30day uses the 30-day Price", async () => {
  await checkout(req({ pass: "30day" }));
  assert.deepEqual(sessionArgs.line_items, [{ price: "price_30", quantity: 1 }]);
});
await check("checkout: a missing Price is 503, not a checkout", async () => {
  const saved = process.env.STRIPE_PRICE_30DAY;
  delete process.env.STRIPE_PRICE_30DAY;
  sessionArgs = null;
  const r = await quiet(() => checkout(req({ pass: "30day" })));
  process.env.STRIPE_PRICE_30DAY = saved;
  assert.equal(r.statusCode, 503);
  assert.equal(sessionArgs, null);
});

await check("checkout: a refund 5 days ago is 403 with the date, no Stripe session", async () => {
  refundRows = [{ refunded_at: daysAgo(5) }]; sessionArgs = null;
  const r = await checkout(req({ pass: "7day" }));
  assert.equal(r.statusCode, 403);
  const body = JSON.parse(r.body);
  assert.match(body.error, /21 days/);
  const until = new Date(body.blocked_until).getTime();
  assert.ok(Math.abs(until - (Date.now() + 16 * 86_400_000)) < 60_000, "blocked until refund + 21 days");
  assert.equal(sessionArgs, null);
});
await check("checkout: the lookup only asks for refunds inside the last 21 days", async () => {
  refundRows = []; refundFilter = null;
  await checkout(req({ pass: "7day" }));
  assert.equal(refundFilter[0], "refunded_at");
  assert.ok(Math.abs(new Date(refundFilter[1]).getTime() - (Date.now() - 21 * 86_400_000)) < 60_000);
});
await check("checkout: no recent refund sells normally", async () => {
  refundRows = []; sessionArgs = null;
  assert.equal((await checkout(req({ pass: "30day" }))).statusCode, 200);
  assert.ok(sessionArgs);
});
await check("checkout: internal accounts are exempt (owner testing refunds)", async () => {
  refundRows = [{ refunded_at: daysAgo(1) }]; internal = true; sessionArgs = null;
  const r = await checkout(req({ pass: "7day" }));
  internal = false;
  assert.equal(r.statusCode, 200);
});
await check("checkout: a failed lookup lets the sale through (fails open)", async () => {
  refundRows = null; refundErr = { message: "db down" }; sessionArgs = null;
  const r = await quiet(() => checkout(req({ pass: "7day" })));
  refundErr = null; refundRows = [];
  assert.equal(r.statusCode, 200);
  assert.ok(logs.some((l) => l.includes("refund cooldown lookup failed")));
});

// ── webhook ─────────────────────────────────────────────────────────
let grants = [];
let grantResult = { data: { ends_at: "2026-10-03T00:00:00Z", duplicate: false }, error: null };
supabaseAdmin.rpc = async (fn, args) => {
  if (fn === "grant_pass") { grants.push(args); return grantResult; }
  return rpcRouter(fn, args);
};
let rpcRouter = async () => ({ data: null, error: null });

function signed(obj, { secret = "whsec_test_fake", base64 = false } = {}) {
  const payload = JSON.stringify(obj);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  return {
    httpMethod: "POST",
    headers: { "stripe-signature": header },
    body: base64 ? Buffer.from(payload).toString("base64") : payload,
    isBase64Encoded: base64,
  };
}
const completed = (over = {}) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { id: "cs_1", payment_status: "paid", amount_total: 199, currency: "usd", payment_intent: "pi_1", metadata: { user_id: USER, pass: "7day" }, ...over } },
});

await check("webhook: bad signature is 400 and grants nothing", async () => {
  grants = [];
  const ev = signed(completed(), { secret: "whsec_wrong" });
  assert.equal((await quiet(() => webhook(ev))).statusCode, 400);
  assert.equal(grants.length, 0);
});
await check("webhook: a body edited after signing is 400", async () => {
  grants = [];
  const ev = signed(completed());
  ev.body = ev.body.replace('"7day"', '"30day"');
  assert.equal((await quiet(() => webhook(ev))).statusCode, 400);
  assert.equal(grants.length, 0);
});
await check("webhook: paid checkout grants once, days from the server map", async () => {
  grants = [];
  const r = await quiet(() => webhook(signed(completed())));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(grants, [{ p_user_id: USER, p_session_id: "cs_1", p_pass: "7day", p_days: 7, p_amount_cents: 199, p_currency: "usd", p_payment_intent: "pi_1" }]);
  assert.ok(logs.some((l) => l.includes('"event":"pass_granted"')));
  assert.ok(!logs.join("\n").includes(USER), "user id in logs");
});
await check("webhook: base64 bodies verify too", async () => {
  grants = [];
  assert.equal((await quiet(() => webhook(signed(completed(), { base64: true })))).statusCode, 200);
  assert.equal(grants.length, 1);
});
await check("webhook: a replay reaches grant_pass (idempotent there) and logs no second grant", async () => {
  grantResult = { data: { ends_at: "2026-10-03T00:00:00Z", duplicate: true }, error: null };
  const r = await quiet(() => webhook(signed(completed())));
  grantResult = { data: { ends_at: "2026-10-03T00:00:00Z", duplicate: false }, error: null };
  assert.equal(r.statusCode, 200);
  assert.ok(!logs.some((l) => l.includes("pass_granted")));
});
await check("webhook: unpaid, other events, unknown passes: 200, nothing granted", async () => {
  grants = [];
  for (const ev of [
    completed({ payment_status: "unpaid" }),
    { id: "evt_2", type: "payment_intent.succeeded", data: { object: {} } },
    completed({ metadata: { user_id: USER, pass: "lifetime" } }),
    completed({ metadata: { pass: "7day" } }),
  ]) {
    assert.equal((await quiet(() => webhook(signed(ev)))).statusCode, 200);
  }
  assert.equal(grants.length, 0);
});
await check("webhook: a failed grant is 500 so Stripe retries", async () => {
  grantResult = { data: null, error: { message: "db down" } };
  const r = await quiet(() => webhook(signed(completed())));
  grantResult = { data: { ends_at: "x", duplicate: false }, error: null };
  assert.equal(r.statusCode, 500);
});

// ── refunds (charge.refunded) ───────────────────────────────────────
let revokes = [];
let revokeResult = { data: { revoked: true, pass: "7day" }, error: null };
rpcRouter = async (fn, args) => {
  if (fn === "revoke_pass") { revokes.push(args); return revokeResult; }
  return { data: null, error: null };
};
const refundEvent = (charge) => ({ id: "evt_r", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_1", refunded: true, ...charge } } });

await check("refund: a full refund takes the pass back by payment intent", async () => {
  revokes = [];
  const r = await quiet(() => webhook(signed(refundEvent({}))));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(revokes, [{ p_payment_intent: "pi_1" }]);
  assert.ok(logs.some((l) => l.includes('"event":"pass_refunded"')));
});
await check("refund: an expanded payment_intent object works too", async () => {
  revokes = [];
  await quiet(() => webhook(signed(refundEvent({ payment_intent: { id: "pi_2" } }))));
  assert.deepEqual(revokes, [{ p_payment_intent: "pi_2" }]);
});
await check("refund: a partial refund leaves the pass alone", async () => {
  revokes = [];
  const r = await quiet(() => webhook(signed(refundEvent({ refunded: false, amount_refunded: 50 }))));
  assert.equal(r.statusCode, 200);
  assert.equal(revokes.length, 0);
});
await check("refund: a forged refund (bad signature) revokes nothing", async () => {
  revokes = [];
  assert.equal((await quiet(() => webhook(signed(refundEvent({}), { secret: "whsec_wrong" })))).statusCode, 400);
  assert.equal(revokes.length, 0);
});
await check("refund: a failed revoke is 500 so Stripe retries", async () => {
  revokeResult = { data: null, error: { message: "db down" } };
  const r = await quiet(() => webhook(signed(refundEvent({}))));
  revokeResult = { data: { revoked: true, pass: "7day" }, error: null };
  assert.equal(r.statusCode, 500);
});
await check("refund: repeat and unknown refunds are 200 with nothing logged as refunded", async () => {
  revokeResult = { data: { revoked: false, reason: "already_refunded" }, error: null };
  assert.equal((await quiet(() => webhook(signed(refundEvent({}))))).statusCode, 200);
  assert.ok(!logs.some((l) => l.includes("pass_refunded")));
  revokeResult = { data: { revoked: false, reason: "not_found" }, error: null };
  assert.equal((await quiet(() => webhook(signed(refundEvent({}))))).statusCode, 200);
  revokeResult = { data: { revoked: true, pass: "7day" }, error: null };
});

// ── photo-read and rollover ─────────────────────────────────────────
function seg(marker, payload) {
  const len = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 0xff]), payload]);
}
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  seg(0xdb, Buffer.from([0x00, ...Array(64).fill(0x10)])),
  seg(0xc0, Buffer.from([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00])),
  seg(0xc4, Buffer.from([0x00, 0x01, ...Array(15).fill(0), 0x00])),
  seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
  Buffer.alloc(300, 0x11),
  Buffer.from([0xff, 0xd9]),
]);
const IMAGE = "data:image/jpeg;base64," + jpeg.toString("base64");

let userRow = { daily_message_count: 0, last_message_date: null, is_subscribed: false, subscription_expires: null, is_founder: false, age_verified: true, self_reported_age_band: null };
const QUOTA = { daily_limit: 3, used_today: 3, remaining_today: 0, rollover: 4 };
let claimResult;
let claimArgs = [];
let released = [];
rpcRouter = async (fn, args) => {
  if (fn === "claim_photo") { claimArgs.push(args); return claimResult; }
  if (fn === "release_photo") { released.push(args.p_id); return { data: null, error: null }; }
  return { data: null, error: null };
};
supabaseAdmin.from = (table) => {
  const b = {
    select: () => b, eq: () => b, not: () => b, is: () => b, order: () => b, limit: () => b,
    update: () => b,
    single: async () => ({ data: table === "threads" ? { id: "t1", tab: "plant" } : userRow, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (res) => Promise.resolve({ data: null, error: null }).then(res),
  };
  return b;
};
let visionOk = true;
globalThis.fetch = async () => (visionOk
  ? { ok: true, status: 200, json: async () => ({ model: "test/vision", usage: {}, choices: [{ message: { content: JSON.stringify({ status: "ok", subject: "leaves", lighting_distorted: false, image_problems: [], observations: ["yellow lower leaves"], healthy_looking: false, matches: [], ask: "", other_plant: "" }) } }] }) }
  : { ok: false, status: 500, text: async () => "down", json: async () => ({}) });

const send = (extra = {}) => quiet(() => photoRead(req({ thread_id: "t1", image: IMAGE, ...extra })));

await check("photo-read: today's photos gone + rollover left, no allow_rollover: 409 rollover_confirm", async () => {
  claimArgs = [];
  claimResult = { data: { id: null, needs_confirm: true, photos: QUOTA }, error: null };
  const r = await send();
  assert.equal(r.statusCode, 409);
  const b = JSON.parse(r.body);
  assert.equal(b.code, "rollover_confirm");
  assert.equal(b.photos.rollover, 4);
  assert.equal(claimArgs[0].p_allow_rollover, false);
});
await check("photo-read: allow_rollover passes through and the read succeeds", async () => {
  claimArgs = [];
  claimResult = { data: { id: "read-1", needs_confirm: false, photos: { ...QUOTA, rollover: 3 } }, error: null };
  const r = await send({ allow_rollover: true });
  assert.equal(r.statusCode, 200, r.body);
  const b = JSON.parse(r.body);
  assert.equal(b.photo_read_id, "read-1");
  assert.equal(b.photos.rollover, 3);
  assert.equal(claimArgs[0].p_allow_rollover, true);
});
await check("photo-read: only a literal true allows rollover", async () => {
  claimArgs = [];
  claimResult = { data: { id: null, needs_confirm: true, photos: QUOTA }, error: null };
  await send({ allow_rollover: "true" });
  assert.equal(claimArgs[0].p_allow_rollover, false);
});
await check("photo-read: nothing left at all is 429 photo_limit with the quota", async () => {
  claimResult = { data: { id: null, needs_confirm: false, photos: { ...QUOTA, rollover: 0 } }, error: null };
  const r = await send();
  assert.equal(r.statusCode, 429);
  assert.equal(JSON.parse(r.body).code, "photo_limit");
});
await check("photo-read: a failed vision call releases the photo back", async () => {
  released = [];
  visionOk = false;
  claimResult = { data: { id: "read-2", needs_confirm: false, photos: QUOTA }, error: null };
  const r = await send({ allow_rollover: true });
  visionOk = true;
  assert.equal(r.statusCode, 502);
  assert.deepEqual(released, ["read-2"]);
});
await check("photo-read: limits come from the environment, by pass status", async () => {
  claimResult = { data: { id: null, needs_confirm: false, photos: QUOTA }, error: null };
  claimArgs = [];
  userRow = { ...userRow, is_subscribed: false };
  await send();
  userRow = { ...userRow, is_subscribed: true, subscription_expires: new Date(Date.now() + 86400000).toISOString() };
  await send();
  userRow = { ...userRow, is_subscribed: true, subscription_expires: new Date(Date.now() - 86400000).toISOString() };
  await send();
  assert.deepEqual(claimArgs.map((a) => [a.p_daily_limit, a.p_paid_limit]), [
    [PHOTO_DAILY_LIMIT, PHOTO_DAILY_LIMIT_UNLIMITED],
    [PHOTO_DAILY_LIMIT_UNLIMITED, PHOTO_DAILY_LIMIT_UNLIMITED],
    [PHOTO_DAILY_LIMIT, PHOTO_DAILY_LIMIT_UNLIMITED], // an ended pass is the free allowance
  ]);
});

// ── profile/settings ────────────────────────────────────────────────
let settingsPatch = null;
supabaseAdmin.from = () => {
  const b = { update: (p) => { settingsPatch = p; return b; }, eq: async () => ({ error: null }) };
  return b;
};
await check("settings: saves only the two booleans", async () => {
  const r = await settings(req({ warn_rollover: false, skip_training_prompt: true, is_subscribed: true, photo_rollover: 99 }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(settingsPatch, { warn_rollover: false, skip_training_prompt: true });
});
await check("settings: non-booleans and empty bodies are 400", async () => {
  assert.equal((await settings(req({ warn_rollover: "no" }))).statusCode, 400);
  assert.equal((await settings(req({ photo_rollover: 99 }))).statusCode, 400);
});

if (failures.length) console.log(failures.join("\n"));
console.log(`\npasses check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.error("\nPasses are NOT safe to ship. Do not deploy.");
  process.exit(1);
}
console.log("All passes checks passed.");
