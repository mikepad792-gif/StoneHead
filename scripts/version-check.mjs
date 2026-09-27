// scripts/version-check.mjs
// App version: run with  node scripts/version-check.mjs  (also in `npm run check`).
//
//   1. src/version.js APP_VERSION equals package.json "version", and both are
//      MAJOR.MINOR.PATCH. Release routine: bump both; this keeps them honest.
//   2. Every message chat-send stores carries app_version.
//   3. The data toggle stamps data_opt_in_version when turned ON, and leaves
//      it alone when turned OFF.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";

const { APP_VERSION } = await import("../src/version.js");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}

const SEMVER = /^\d+\.\d+\.\d+$/;
await check("APP_VERSION is MAJOR.MINOR.PATCH", () => assert.match(APP_VERSION, SEMVER));
await check("package.json version is MAJOR.MINOR.PATCH", () => assert.match(pkg.version, SEMVER));
await check("APP_VERSION matches package.json", () => assert.equal(APP_VERSION, pkg.version));

await check("every message chat-send inserts carries app_version", () => {
  const src = readFileSync(new URL("../api/chat-send.js", import.meta.url), "utf8");
  // A stored message row is the only object literal with both role and tokens_out.
  const rows = src.match(/\{[^{}]*\brole:[^{}]*\btokens_out\b[^{}]*\}/g) || [];
  assert.ok(rows.length >= 4, `expected 4 message inserts, found ${rows.length}`);
  const missing = rows.filter((r) => !/app_version:\s*APP_VERSION/.test(r));
  assert.equal(missing.length, 0, `${missing.length} message insert(s) without app_version`);
});

// ── Data toggle, against a stubbed Supabase ─────────────────────────
const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler: toggle } = await import("../api/threads-toggle-data.js");
let updates = [];
supabase.auth.getUser = async () => ({ data: { user: { id: "u1" } }, error: null });
supabaseAdmin.from = () => {
  let payload = null;
  const b = {
    select: () => b,
    eq: () => b,
    update: (p) => { payload = p; updates.push(p); return b; },
    single: async () => ({ data: payload ? { data_opt_in: payload.data_opt_in } : { id: "t1", user_id: "u1" }, error: null }),
  };
  return b;
};
const flip = (on) => toggle({ httpMethod: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ thread_id: "t1", data_opt_in: on }) });

await check("toggle ON stamps data_opt_in_version", async () => {
  updates = [];
  assert.equal((await flip(true)).statusCode, 200);
  assert.deepEqual(updates, [{ data_opt_in: true, data_opt_in_version: APP_VERSION }]);
});
await check("toggle OFF leaves data_opt_in_version alone", async () => {
  updates = [];
  assert.equal((await flip(false)).statusCode, 200);
  assert.deepEqual(updates, [{ data_opt_in: false }]);
});

if (failures.length) console.log(failures.join("\n"));
console.log(`\nversion check: passed=${passed} failed=${failures.length} (v${APP_VERSION})`);
if (failures.length) process.exit(1);
