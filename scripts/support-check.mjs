// scripts/support-check.mjs
// The support form endpoint (api/support.js): run with  node scripts/support-check.mjs
// (also in `npm run check`). Stubbed Supabase and email, no network.
//
// Pins: the account id, username and account email come from the session,
// never the body; the typed email is only the reply-to; the report is saved
// even when email fails; a daily cap; and input validation.

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.AI_MODEL ||= "test/model";
process.env.OPENROUTER_API_KEY ||= "test-key";
delete process.env.SUPPORT_EMAIL_TO;
delete process.env.SUPPORT_EMAIL_FROM;

const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { setEmailSenderForTests } = await import("../lib/email.js");
const { handler, DAILY_LIMIT, MAX_MESSAGE } = await import("../api/support.js");
const { APP_VERSION } = await import("../src/version.js");

const USER = "user-1";
supabase.auth.getUser = async (t) =>
  t === "good" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad" } };

// ── stubs ───────────────────────────────────────────────────────────
let recentCount = 0, saveError = null, inserted = [], updates = [], emails = [], emailResult = { ok: true, id: "em_1" };
supabaseAdmin.from = (table) => {
  const q = {
    _op: null, _row: null,
    select: (_c, opts) => { if (opts?.head) q._op = "count"; return q; },
    eq: () => (q._op === "update" ? Promise.resolve({ error: null }) : q),
    gte: async () => ({ count: recentCount, error: null }),
    maybeSingle: async () => ({ data: table === "users" ? { username: "mike", email: "acct@example.com" } : null, error: null }),
    insert: (row) => { q._op = "insert"; q._row = row; return q; },
    single: async () => {
      if (saveError) return { data: null, error: saveError };
      inserted.push({ table, ...q._row });
      return { data: { id: "req-1" }, error: null };
    },
    update: (patch) => { q._op = "update"; updates.push({ table, patch }); return q; },
  };
  return q;
};
setEmailSenderForTests(async (payload) => { emails.push(payload); return emailResult; });

let logs = [];
const quiet = async (fn) => {
  const e = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try { return await fn(); } finally { console.error = e; }
};
const req = (body, { token = "good", method = "POST" } = {}) => ({
  httpMethod: method,
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: JSON.stringify(body),
});
const reset = () => { recentCount = 0; saveError = null; inserted = []; updates = []; emails = []; emailResult = { ok: true, id: "em_1" }; logs = []; };

let passed = 0;
const failures = [];
async function check(name, fn) {
  reset();
  try { await fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}

const good = { email: "me@example.com", message: "photos won't upload" };

await check("GET is 405", async () => {
  assert.equal((await handler(req(good, { method: "GET" }))).statusCode, 405);
});
await check("no session is 401, nothing saved or sent", async () => {
  assert.equal((await handler(req(good, { token: null }))).statusCode, 401);
  assert.equal(inserted.length + emails.length, 0);
});
for (const [name, body] of [
  ["missing email", { message: "hi" }],
  ["not an email", { email: "nope", message: "hi" }],
  ["email with a newline (header injection)", { email: "a@b.co\nBcc: x@y.z", message: "hi" }],
  ["email over 254 chars", { email: `${"a".repeat(250)}@b.co`, message: "hi" }],
  ["empty message", { email: "me@example.com", message: "   " }],
  ["message over the limit", { email: "me@example.com", message: "x".repeat(MAX_MESSAGE + 1) }],
  ["message not text", { email: "me@example.com", message: { a: 1 } }],
]) {
  await check(`${name} is 400`, async () => {
    assert.equal((await handler(req(body))).statusCode, 400);
    assert.equal(inserted.length + emails.length, 0);
  });
}

await check("sends to support@ with the user's email as reply-to", async () => {
  const r = await handler(req(good));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { success: true, emailed: true });
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ["support@stoneheadai.com"]);
  assert.equal(emails[0].reply_to, "me@example.com");
  assert.match(emails[0].from, /@stoneheadai\.com>$/);
  assert.match(emails[0].subject, /\[StoneHead support\] mike/);
});
await check("the account id comes from the session, not the body", async () => {
  await handler(req({ ...good, user_id: "someone-else", account_id: "someone-else" }));
  assert.match(emails[0].text, new RegExp(`Account ID: ${USER}\\n`));
  assert.ok(!emails[0].text.includes("someone-else"));
  assert.equal(inserted[0].user_id, USER);
  assert.ok(!("account_id" in inserted[0]));
});
await check("the email body carries account details, version, report id and the message", async () => {
  await handler(req(good));
  const t = emails[0].text;
  for (const s of ["Reply to: me@example.com", "Username: mike", "Account email: acct@example.com",
    `App version: ${APP_VERSION}`, "Report ID: req-1", "photos won't upload"]) {
    assert.ok(t.includes(s), `missing: ${s}`);
  }
});
await check("the report is saved, then marked emailed", async () => {
  await handler(req(good));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].table, "support_requests");
  assert.equal(inserted[0].email, "me@example.com");
  assert.equal(inserted[0].message, "photos won't upload");
  assert.equal(inserted[0].app_version, APP_VERSION);
  assert.deepEqual(updates, [{ table: "support_requests", patch: { emailed: true } }]);
});
await check("email down: still saved, 200 with emailed false, not marked", async () => {
  emailResult = { ok: false, error: "resend 500" };
  const r = await quiet(() => handler(req(good)));
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).emailed, false);
  assert.equal(inserted.length, 1);
  assert.equal(updates.length, 0);
  assert.ok(logs.some((l) => l.includes("support: email failed")));
});
await check("database down: still emailed, 200", async () => {
  saveError = { message: "relation does not exist" };
  const r = await quiet(() => handler(req(good)));
  assert.equal(r.statusCode, 200);
  assert.equal(emails.length, 1);
  assert.match(emails[0].text, /Report ID: \(not saved\)/);
});
await check("both down: 502 that names the address to write to", async () => {
  saveError = { message: "down" }; emailResult = { ok: false, error: "down" };
  const r = await quiet(() => handler(req(good)));
  assert.equal(r.statusCode, 502);
  assert.match(JSON.parse(r.body).error, /support@stoneheadai\.com/);
});
await check(`the ${DAILY_LIMIT + 1}th report in a day is 429, nothing sent`, async () => {
  recentCount = DAILY_LIMIT;
  const r = await handler(req(good));
  assert.equal(r.statusCode, 429);
  assert.equal(inserted.length + emails.length, 0);
});
await check("a newline in the username can't reach the subject line", async () => {
  const realFrom = supabaseAdmin.from;
  supabaseAdmin.from = (t) => {
    const q = realFrom(t);
    if (t === "users") q.maybeSingle = async () => ({ data: { username: "mike\r\nBcc: x@y.z", email: "a@b.co" }, error: null });
    return q;
  };
  await handler(req(good));
  supabaseAdmin.from = realFrom;
  assert.ok(!/[\r\n]/.test(emails[0].subject));
});
await check("SUPPORT_EMAIL_TO and SUPPORT_EMAIL_FROM override the defaults", async () => {
  process.env.SUPPORT_EMAIL_TO = "help@example.com";
  process.env.SUPPORT_EMAIL_FROM = "Help <help@example.com>";
  await handler(req(good));
  delete process.env.SUPPORT_EMAIL_TO;
  delete process.env.SUPPORT_EMAIL_FROM;
  assert.deepEqual(emails[0].to, ["help@example.com"]);
  assert.equal(emails[0].from, "Help <help@example.com>");
});

// The real sender, without the hook: no key means no network call.
setEmailSenderForTests(null);
const { sendEmail } = await import("../lib/email.js");
await check("sendEmail without RESEND_API_KEY returns ok:false and doesn't throw", async () => {
  const saved = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const r = await sendEmail({ from: "a@b.co", to: "c@d.co", subject: "s", text: "t" });
  if (saved) process.env.RESEND_API_KEY = saved;
  assert.equal(r.ok, false);
  assert.match(r.error, /RESEND_API_KEY/);
});

console.log(`support check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("All support checks passed.");
