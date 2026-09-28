// scripts/avatar-check.mjs
// Profile avatars (v2.1.2): run with  node scripts/avatar-check.mjs
// (also in `npm run check`). Stubbed Supabase, no network.
//
// Pins: every avatar in src/avatars.js has its file; saves reject unknown
// ids and 21+ ids for accounts that fail the Talk the Plant gate; and
// profile/get drops a 21+ avatar once the gate flips (age detection can
// set a minor band after the avatar was picked).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.AI_MODEL ||= "test/model";
process.env.OPENROUTER_API_KEY ||= "test-key";

const { AVATARS, AVATAR_PATH } = await import("../src/avatars.js");
const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler: settings } = await import("../api/profile-settings.js");
const { handler: profileGet } = await import("../api/profile-get.js");
const { visibleAvatarId, passesAdultGate } = await import("../lib/avatars.js");

const USER = "user-1";
supabase.auth.getUser = async (t) =>
  t === "good" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad" } };

// ── a chainable stub: every query on "users" sees `row`, others see nothing ──
let row = {};
let updates = [];
supabaseAdmin.rpc = async () => ({ data: null, error: null });
supabaseAdmin.from = (table) => {
  const result = () => (table === "users" ? { data: { ...row }, error: null } : { data: [], error: null, count: 0 });
  const q = {
    select: () => q, eq: () => q, gt: () => q, gte: () => q, lt: () => q, in: () => q, order: () => q, is: () => q,
    limit: async () => ({ data: [], error: null }),
    single: async () => result(),
    maybeSingle: async () => result(),
    update: (patch) => { updates.push({ table, patch }); return { eq: async () => ({ error: null }) }; },
    then: (res, rej) => Promise.resolve(result()).then(res, rej),
  };
  return q;
};

const post = (body, token = "good") => ({
  httpMethod: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
});
const get = () => ({ httpMethod: "GET", headers: { authorization: "Bearer good" }, queryStringParameters: {} });

let passed = 0;
const failures = [];
async function check(name, fn) {
  updates = [];
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}
const quiet = async (fn) => {
  const e = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = e; }
};

const ALL_AGES = AVATARS.find((a) => !a.adult).id;
const ADULT = AVATARS.find((a) => a.adult).id;
const VERIFIED = { age_verified: true, self_reported_age_band: null };

// ── the list ────────────────────────────────────────────────────────
await check("every avatar has a file in public/avatars", () => {
  assert.equal(AVATAR_PATH, "/avatars/");
  for (const a of AVATARS) assert.ok(existsSync(new URL(`../public/avatars/${a.file}`, import.meta.url)), a.file);
});
await check("ids are unique, labels present, adult is a boolean", () => {
  assert.equal(new Set(AVATARS.map((a) => a.id)).size, AVATARS.length);
  for (const a of AVATARS) { assert.ok(a.label); assert.equal(typeof a.adult, "boolean"); }
});
await check("both sets are non-empty (15 all ages, 44 21+)", () => {
  assert.equal(AVATARS.filter((a) => !a.adult).length, 15);
  assert.equal(AVATARS.filter((a) => a.adult).length, 44);
});

// ── the gate ────────────────────────────────────────────────────────
await check("gate: verified passes; unverified, minor, under_21 and under_13 fail", () => {
  assert.equal(passesAdultGate(VERIFIED), true);
  assert.equal(passesAdultGate({ age_verified: false }), false);
  for (const band of ["minor", "under_21", "under_13"]) {
    assert.equal(passesAdultGate({ age_verified: true, self_reported_age_band: band }), false, band);
  }
  assert.equal(passesAdultGate(null), false);
});

// ── saving ──────────────────────────────────────────────────────────
await check("save: no session is 401", async () => {
  assert.equal((await settings(post({ avatar_id: ALL_AGES }, null))).statusCode, 401);
});
for (const bad of ["not-an-avatar", "../../etc/passwd", 7, true, { id: ALL_AGES }, "__proto__"]) {
  await check(`save: ${JSON.stringify(bad)} is 400, nothing written`, async () => {
    row = VERIFIED;
    assert.equal((await settings(post({ avatar_id: bad }))).statusCode, 400);
    assert.equal(updates.length, 0);
  });
}
await check("save: an all-ages avatar works without age verification", async () => {
  row = { age_verified: false };
  const r = await settings(post({ avatar_id: ALL_AGES }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(updates, [{ table: "users", patch: { avatar_id: ALL_AGES } }]);
});
await check("save: a 21+ avatar is 403 for an unverified account", async () => {
  row = { age_verified: false };
  assert.equal((await settings(post({ avatar_id: ADULT }))).statusCode, 403);
  assert.equal(updates.length, 0);
});
await check("save: a 21+ avatar is 403 when a minor band overrides verification", async () => {
  row = { age_verified: true, self_reported_age_band: "under_21" };
  assert.equal((await settings(post({ avatar_id: ADULT }))).statusCode, 403);
  assert.equal(updates.length, 0);
});
await check("save: a 21+ avatar works for a verified account", async () => {
  row = VERIFIED;
  const r = await settings(post({ avatar_id: ADULT }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(updates, [{ table: "users", patch: { avatar_id: ADULT } }]);
});
await check("save: null goes back to the letter", async () => {
  row = { age_verified: false };
  assert.equal((await settings(post({ avatar_id: null }))).statusCode, 200);
  assert.deepEqual(updates, [{ table: "users", patch: { avatar_id: null } }]);
});
await check("save: the toggles still work alongside", async () => {
  row = VERIFIED;
  const r = await settings(post({ warn_rollover: false, avatar_id: ALL_AGES }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(updates[0].patch, { warn_rollover: false, avatar_id: ALL_AGES });
});

// ── reading ─────────────────────────────────────────────────────────
const profileRow = (extra) => ({
  id: USER, username: "mike", email: "m@x.co", is_subscribed: false, subscription_expires: null,
  daily_message_count: 0, last_message_date: null, is_founder: false, founder_number: null,
  tos_accepted_at: null, tos_version: null, ...extra,
});
await check("read: a verified account gets its 21+ avatar", async () => {
  row = profileRow({ ...VERIFIED, avatar_id: ADULT });
  const r = await quiet(() => profileGet(get()));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).avatar_id, ADULT);
});
await check("read: after the gate flips (minor band), a 21+ avatar comes back null", async () => {
  row = profileRow({ age_verified: true, self_reported_age_band: "minor", avatar_id: ADULT });
  const r = await quiet(() => profileGet(get()));
  assert.equal(JSON.parse(r.body).avatar_id, null);
});
await check("read: an all-ages avatar survives the gate flipping", async () => {
  row = profileRow({ age_verified: true, self_reported_age_band: "minor", avatar_id: ALL_AGES });
  const r = await quiet(() => profileGet(get()));
  assert.equal(JSON.parse(r.body).avatar_id, ALL_AGES);
});
await check("read: an id no longer in the list comes back null", async () => {
  row = profileRow({ ...VERIFIED, avatar_id: "retired-avatar" });
  const r = await quiet(() => profileGet(get()));
  assert.equal(JSON.parse(r.body).avatar_id, null);
});
await check("visibleAvatarId: null and junk are null", () => {
  assert.equal(visibleAvatarId(null, VERIFIED), null);
  assert.equal(visibleAvatarId(42, VERIFIED), null);
});

console.log(`avatar check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("All avatar checks passed.");
