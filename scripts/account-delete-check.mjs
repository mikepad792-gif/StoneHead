// scripts/account-delete-check.mjs
// In-app account deletion: run with  node scripts/account-delete-check.mjs
// (also in `npm run check`).
//
// Drives api/account-delete.js against stubbed Supabase clients. No network,
// no database. What it keeps true:
//   1. Only the session's own account can be deleted, and only on "delete".
//   2. Database first, login second, and a failed first step never reaches
//      the second.
//   3. A half-finished delete can be retried to completion.
//   4. The log line never carries who it was.

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";

const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler } = await import("../api/account-delete.js");

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const EMAIL = "someone@example.com";

// ── Stubs ───────────────────────────────────────────────────────────
let calls, rpcResult, deleteUserResult, logs;
function reset() {
  calls = [];
  rpcResult = { data: { retained: 2, deleted: true }, error: null };
  deleteUserResult = { data: {}, error: null };
  logs = [];
}
supabase.auth.getUser = async (token) =>
  token === "good-token"
    ? { data: { user: { id: USER, email: EMAIL } }, error: null }
    : { data: { user: null }, error: { message: "bad token" } };
supabaseAdmin.rpc = async (fn, args) => { calls.push(["rpc", fn, args]); return rpcResult; };
supabaseAdmin.auth.admin.deleteUser = async (id) => { calls.push(["deleteUser", id]); return deleteUserResult; };

const realLog = console.log, realErr = console.error;
function capture() {
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
}
function release() { console.log = realLog; console.error = realErr; }

async function call(body, { token = "good-token", method = "POST" } = {}) {
  capture();
  try {
    return await handler({
      httpMethod: method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    });
  } finally { release(); }
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  reset();
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}

await check("no session: 401, nothing called", async () => {
  const r = await call({ confirm: "delete" }, { token: null });
  assert.equal(r.statusCode, 401);
  assert.deepEqual(calls, []);
});
await check("bad session: 401, nothing called", async () => {
  const r = await call({ confirm: "delete" }, { token: "nope" });
  assert.equal(r.statusCode, 401);
  assert.deepEqual(calls, []);
});
await check("GET: 405", async () => {
  assert.equal((await call({ confirm: "delete" }, { method: "GET" })).statusCode, 405);
});
for (const bad of [{}, { confirm: "" }, { confirm: "yes" }, { confirm: "delete!" }, { confirm: true }]) {
  await check(`confirm ${JSON.stringify(bad)}: 400, rpc never called`, async () => {
    assert.equal((await call(bad)).statusCode, 400);
    assert.deepEqual(calls, []);
  });
}
await check("confirm is trimmed and case-insensitive", async () => {
  assert.equal((await call({ confirm: "  DeLeTe " })).statusCode, 200);
});
await check("happy path: rpc with the session's id, then deleteUser, in order", async () => {
  const r = await call({ confirm: "delete" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { success: true });
  assert.deepEqual(calls, [["rpc", "delete_account", { p_user_id: USER }], ["deleteUser", USER]]);
});
await check("a user_id in the body is ignored", async () => {
  await call({ confirm: "delete", user_id: OTHER, p_user_id: OTHER });
  assert.deepEqual(calls, [["rpc", "delete_account", { p_user_id: USER }], ["deleteUser", USER]]);
});
await check("rpc error: 500, deleteUser never called", async () => {
  rpcResult = { data: null, error: { message: "boom" } };
  assert.equal((await call({ confirm: "delete" })).statusCode, 500);
  assert.deepEqual(calls.map((c) => c[0]), ["rpc"]);
});
await check("deleteUser error: 500, then a retry (deleted: false) succeeds", async () => {
  deleteUserResult = { data: null, error: { message: "auth down", status: 500 } };
  assert.equal((await call({ confirm: "delete" })).statusCode, 500);
  rpcResult = { data: { retained: 0, deleted: false }, error: null };
  deleteUserResult = { data: {}, error: null };
  calls = [];
  assert.equal((await call({ confirm: "delete" })).statusCode, 200);
  assert.deepEqual(calls.map((c) => c[0]), ["rpc", "deleteUser"]);
});
await check("login already gone (404) on retry: still success", async () => {
  rpcResult = { data: { retained: 0, deleted: false }, error: null };
  deleteUserResult = { data: null, error: { message: "User not found", status: 404 } };
  assert.equal((await call({ confirm: "delete" })).statusCode, 200);
});
await check("the log line has no user id or email, and does have the event", async () => {
  await call({ confirm: "delete" });
  const all = logs.join("\n");
  assert.ok(all.includes('"event":"account_deleted"'), "missing event log");
  assert.ok(all.includes('"retained":2'), "missing retained count");
  assert.ok(!all.includes(USER), "log contains the user id");
  assert.ok(!all.includes(EMAIL), "log contains the email");
});
await check("failure logs carry no user id either", async () => {
  rpcResult = { data: null, error: { message: "boom" } };
  await call({ confirm: "delete" });
  deleteUserResult = { data: null, error: { message: "x", status: 500 } };
  rpcResult = { data: { retained: 0, deleted: true }, error: null };
  await call({ confirm: "delete" });
  assert.ok(!logs.join("\n").includes(USER));
});

// ── Report ──────────────────────────────────────────────────────────
if (failures.length) console.log(failures.join("\n"));
console.log(`\naccount delete check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.error("\nAccount deletion is NOT safe to ship. Do not deploy.");
  process.exit(1);
}
console.log("All account delete checks passed.");
