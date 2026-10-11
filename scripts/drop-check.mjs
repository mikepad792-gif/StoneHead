// scripts/drop-check.mjs
// The Weekly Moai Drop endpoints (v2.2.0): run with  node scripts/drop-check.mjs
// (also in `npm run check`). In-memory tables, stubbed rpc, no network.
//
// The database half (link_discord moving a Discord between accounts, expired
// and used links, round timing, entry counting with the 7-day cap, internal
// and left entries dropped, the founder flag, bonus grants, one draw per
// round, the 4:1 weighted pick over 10,000 draws, the nudge clock, and the
// lockdown) was run against real Postgres; see migration 024. This file pins
// the endpoints around it:
//   - the bot secret on every bot-* endpoint, the owner id on giveaway ones
//   - links: 3 per Discord per 10 minutes, newest wins, 15 minutes, reuse on Enter
//   - linking by token or code, 5 failed tries an hour, checked first
//   - Enter / Leave / status replies, and the closed and cancelled rounds
//   - active days in Pacific time
//   - the pick's randomness comes from crypto, not the database

import assert from "node:assert/strict";

process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.AI_MODEL ||= "test/model";
process.env.OPENROUTER_API_KEY ||= "test-key";
process.env.BOT_SHARED_SECRET = "s3cret";
process.env.OWNER_DISCORD_ID = "1520166782013542422";
process.env.GIVEAWAY_GUILD_IDS = "788166388250443846, 111111111111111111";
process.env.URL = "https://stoneheadai.com";

const { supabase, supabaseAdmin } = await import("../lib/supabase.js");
const { handler: linkStart } = await import("../api/bot-link-start.js");
const { handler: preview, _resetPreviewLimitForTests, PREVIEWS_PER_HOUR } = await import("../api/discord-link-preview.js");
const { handler: link } = await import("../api/discord-link.js");
const { handler: unlink } = await import("../api/discord-unlink.js");
const { handler: create } = await import("../api/bot-round-create.js");
const { handler: setMessage } = await import("../api/bot-round-message.js");
const { handler: enter } = await import("../api/bot-round-enter.js");
const { handler: draw } = await import("../api/bot-round-draw.js");
const { handler: cancel } = await import("../api/bot-round-cancel.js");
const { handler: nudge } = await import("../api/bot-round-nudge.js");
const { pacificDate, isOwner, giveawayGuilds, cleanDiscordName } = await import("../lib/bot.js");
const { recordActiveDay, activeDaysThisWeek, MSG, roundPostText } = await import("../lib/giveaway.js");
const { linkMessage } = await import("../lib/discordLink.js");

const USER = "user-1";
const OWNER = "1520166782013542422";
const GUILD = "788166388250443846";
const CHANNEL = "900000000000000001";
const DISCORD = "300000000000000001";
supabase.auth.getUser = async (t) =>
  t === "good" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad" } };

// ── a tiny in-memory PostgREST ──────────────────────────────────────
let db = {};
let rpcCalls = [], rpcResult = {};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function query(table, op, payload, opts) {
  const filters = [];
  let order = null, limit = null, countMode = false, head = false, returning = false;
  const rows = () => (db[table] ||= []);
  const match = (r) => filters.every((f) => f(r));
  const run = () => {
    if (op === "insert") {
      const row = { created_at: new Date().toISOString(), tried_at: new Date().toISOString(), ...payload };
      if (table === "discord_link_requests" && rows().some((r) => r.short_code === row.short_code || r.token === row.token)) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      rows().push(row);
      return { data: null, error: null };
    }
    if (op === "upsert") {
      const keys = opts.onConflict.split(",");
      const hit = rows().find((r) => keys.every((k) => r[k] === payload[k]));
      if (hit) { if (!opts.ignoreDuplicates) Object.assign(hit, payload); }
      else rows().push({ ...payload });
      return { data: null, error: null };
    }
    if (op === "update") {
      const hit = rows().filter(match);
      hit.forEach((r) => Object.assign(r, payload));
      return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "delete") {
      db[table] = rows().filter((r) => !match(r));
      return { data: null, error: null };
    }
    let out = rows().filter(match);
    if (order) out = [...out].sort((a, b) => cmp(a[order.col], b[order.col]) * (order.asc ? 1 : -1));
    if (limit != null) out = out.slice(0, limit);
    if (countMode) return { data: head ? null : out, count: out.length, error: null };
    return { data: out.map((r) => ({ ...r })), error: null };
  };
  const q = {
    select: (_c, o) => { if (op !== "select") returning = true; if (o?.count) countMode = true; if (o?.head) head = true; return q; },
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    gt: (c, v) => { filters.push((r) => r[c] > v); return q; },
    gte: (c, v) => { filters.push((r) => r[c] >= v); return q; },
    lt: (c, v) => { filters.push((r) => r[c] < v); return q; },
    lte: (c, v) => { filters.push((r) => r[c] <= v); return q; },
    order: (col, o) => { order = { col, asc: o?.ascending !== false }; return q; },
    limit: (n) => { limit = n; return q; },
    maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
    single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
    then: (res, rej) => Promise.resolve(run()).then(res, rej),
  };
  return q;
}
supabaseAdmin.from = (table) => ({
  select: (c, o) => query(table, "select").select(c, o),
  insert: (row) => query(table, "insert", row),
  upsert: (row, opts) => query(table, "upsert", row, opts),
  update: (patch) => query(table, "update", patch),
  delete: () => query(table, "delete"),
});
supabaseAdmin.rpc = async (fn, args) => { rpcCalls.push([fn, args]); return typeof rpcResult === "function" ? rpcResult(fn, args) : rpcResult; };

const botPost = (body, secret = "s3cret") => ({ httpMethod: "POST", headers: secret ? { "x-bot-secret": secret } : {}, body: JSON.stringify(body) });
const userPost = (body, token = "good") => ({ httpMethod: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
const body = (r) => JSON.parse(r.body);
const hoursFromNow = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const openRound = (extra = {}) => ({ id: 7, guild_id: GUILD, channel_id: CHANNEL, status: "open", draw_at: hoursFromNow(48), week_start: pacificDate(new Date(Date.now() - 2 * 86_400_000)), created_at: new Date().toISOString(), ...extra });

let passed = 0;
const failures = [];
async function check(name, fn) {
  db = {}; rpcCalls = []; rpcResult = { data: null, error: null };
  const e = console.error, l = console.log, w = console.warn;
  console.error = () => {}; console.log = () => {}; console.warn = () => {};
  try { await fn(); passed++; }
  catch (err) { failures.push(`  FAIL ${name}\n       ${String(err.message).split("\n").slice(0, 4).join(" ")}`); }
  finally { console.error = e; console.log = l; console.warn = w; }
}

// ── helpers ─────────────────────────────────────────────────────────
await check("pacificDate: 11:30 PM and 12:30 AM Pacific are two days", () => {
  // Oct 15 2026 is PDT (UTC-7).
  assert.equal(pacificDate(new Date("2026-10-16T06:30:00Z")), "2026-10-15");
  assert.equal(pacificDate(new Date("2026-10-16T07:30:00Z")), "2026-10-16");
  // and in PST (UTC-8)
  assert.equal(pacificDate(new Date("2026-12-02T07:59:00Z")), "2026-12-01");
  assert.equal(pacificDate(new Date("2026-12-02T08:01:00Z")), "2026-12-02");
});
await check("recordActiveDay: two messages one Pacific day = one row; next day = two", async () => {
  await recordActiveDay(supabaseAdmin, USER, new Date("2026-10-16T01:00:00Z"));
  await recordActiveDay(supabaseAdmin, USER, new Date("2026-10-16T06:30:00Z"));
  assert.equal(db.user_active_days.length, 1);
  await recordActiveDay(supabaseAdmin, USER, new Date("2026-10-16T07:30:00Z"));
  assert.deepEqual(db.user_active_days.map((r) => r.day), ["2026-10-15", "2026-10-16"]);
});
await check("recordActiveDay never throws", async () => {
  const real = supabaseAdmin.from;
  supabaseAdmin.from = () => { throw new Error("down"); };
  try { await recordActiveDay(supabaseAdmin, USER); } finally { supabaseAdmin.from = real; }
});
await check("activeDaysThisWeek: counts Monday through today, capped at 7", async () => {
  db.user_active_days = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-12"].map((day) => ({ user_id: USER, day }));
  // Wednesday Oct 7: Mon-Wed only (Sunday before and next Monday don't count)
  assert.equal(await activeDaysThisWeek(supabaseAdmin, USER, "2026-10-05", new Date("2026-10-07T20:00:00Z")), 3);
  db.user_active_days = Array.from({ length: 9 }, (_, i) => ({ user_id: USER, day: `2026-10-${String(5 + i).padStart(2, "0")}` }));
  assert.equal(await activeDaysThisWeek(supabaseAdmin, USER, "2026-10-05", new Date("2026-10-20T20:00:00Z")), 7);
});
await check("owner and guild config: unset means nobody, list is trimmed", () => {
  assert.equal(isOwner(OWNER), true);
  assert.equal(isOwner("1520166782013542423"), false);
  assert.equal(isOwner(""), false);
  const saved = process.env.OWNER_DISCORD_ID; delete process.env.OWNER_DISCORD_ID;
  assert.equal(isOwner(""), false); assert.equal(isOwner(undefined), false);
  process.env.OWNER_DISCORD_ID = saved;
  assert.deepEqual(giveawayGuilds(), [GUILD, "111111111111111111"]);
});
await check("cleanDiscordName strips control characters and caps length", () => {
  assert.equal(cleanDiscordName("bob\n\u0000"), "bob");
  assert.equal(cleanDiscordName("x".repeat(100)).length, 64);
  assert.equal(cleanDiscordName(42), null);
});
await check("every line has no em or en dashes", () => {
  const lines = [...Object.values(MSG).map((m) => (typeof m === "function" ? m(3) : m)),
    ...["ok", "bad_link", "too_many", "unlinked", "error"].map((s) => linkMessage(s, { discord_username: "bob", entered_round: true })),
    roundPostText({ prize: "30 day pass", entrant_bonus_days: 7, draw_at: "2026-10-19T04:00:00Z" })];
  for (const l of lines) assert.ok(!/[–—]/.test(l), l);
});
await check("entered line: 1 for entering + days, singular day", () => {
  assert.equal(MSG.entered(3), "You're in this week's Moai Drop. Entries so far: 4 (1 for entering + 3 days using StoneHead). Every day you use StoneHead this week adds one, up to 7.");
  assert.match(MSG.entered(1), /\+ 1 day using/);
});
await check("round post: prize, bonus line only on bonus weeks, Sunday date in Pacific", () => {
  const t = roundPostText({ prize: "30 day pass", entrant_bonus_days: 0, draw_at: "2026-10-19T04:00:00Z" });
  assert.match(t, /Prize: 30 day pass/);
  assert.match(t, /Draw: Sunday Oct 18 at 9 PM Pacific/);
  assert.ok(!/Bonus week/.test(t));
  assert.match(roundPostText({ prize: "p", entrant_bonus_days: 7, draw_at: "2026-10-19T04:00:00Z" }), /everyone who enters gets 7 free days/);
});

// ── bot-link-start ──────────────────────────────────────────────────
await check("link-start: wrong or missing secret is 401; no secret configured refuses all", async () => {
  assert.equal((await linkStart(botPost({ discord_id: DISCORD }, "nope"))).statusCode, 401);
  assert.equal((await linkStart(botPost({ discord_id: DISCORD }, null))).statusCode, 401);
  const saved = process.env.BOT_SHARED_SECRET; delete process.env.BOT_SHARED_SECRET;
  assert.equal((await linkStart(botPost({ discord_id: DISCORD }, ""))).statusCode, 401);
  process.env.BOT_SHARED_SECRET = saved;
  assert.equal(db.discord_link_requests, undefined);
});
await check("link-start: bad discord_id is 400", async () => {
  assert.equal((await linkStart(botPost({ discord_id: "bob" }))).statusCode, 400);
});
await check("link-start: returns a site URL, a 6-digit code, 15 minutes", async () => {
  const b = body(await linkStart(botPost({ discord_id: DISCORD, discord_username: "bob" })));
  assert.match(b.url, /^https:\/\/stoneheadai\.com\/link-discord\?t=[A-Za-z0-9_-]{43}$/);
  assert.match(b.short_code, /^\d{6}$/);
  const mins = (new Date(b.expires_at) - Date.now()) / 60_000;
  assert.ok(mins > 14.9 && mins <= 15, String(mins));
  assert.equal(db.discord_link_requests[0].discord_username, "bob");
});
await check("link-start: a new /link kills the older unused link", async () => {
  const first = body(await linkStart(botPost({ discord_id: DISCORD })));
  await linkStart(botPost({ discord_id: DISCORD }));
  const old = db.discord_link_requests.find((r) => first.url.endsWith(r.token));
  assert.ok(new Date(old.expires_at) <= new Date());
  assert.equal(db.discord_link_requests.filter((r) => new Date(r.expires_at) > new Date()).length, 1);
});
await check("link-start: the 4th in 10 minutes is 429; another Discord is fine", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await linkStart(botPost({ discord_id: DISCORD }))).statusCode, 200);
  assert.equal((await linkStart(botPost({ discord_id: DISCORD }))).statusCode, 429);
  assert.equal((await linkStart(botPost({ discord_id: "300000000000000002" }))).statusCode, 200);
});

// ── preview ─────────────────────────────────────────────────────────
const TOKEN = "A".repeat(43);
await check("preview: live token gives the name and code; used, expired, junk give valid:false", async () => {
  _resetPreviewLimitForTests();
  db.discord_link_requests = [{ token: TOKEN, short_code: "482913", discord_username: "bob", expires_at: hoursFromNow(0.2), used_at: null }];
  const get = (t) => preview({ httpMethod: "GET", headers: { "x-nf-client-connection-ip": "1.1.1.1" }, queryStringParameters: { t } });
  assert.deepEqual(body(await get(TOKEN)), { valid: true, discord_username: "bob", short_code: "482913" });
  assert.deepEqual(body(await get("short")), { valid: false });
  db.discord_link_requests[0].used_at = new Date().toISOString();
  assert.deepEqual(body(await get(TOKEN)), { valid: false });
  db.discord_link_requests[0].used_at = null; db.discord_link_requests[0].expires_at = hoursFromNow(-0.1);
  assert.deepEqual(body(await get(TOKEN)), { valid: false });
});
await check(`preview: lookup ${PREVIEWS_PER_HOUR + 1} from one IP in an hour is 429`, async () => {
  _resetPreviewLimitForTests();
  const get = () => preview({ httpMethod: "GET", headers: { "x-nf-client-connection-ip": "2.2.2.2" }, queryStringParameters: { t: TOKEN } });
  for (let i = 0; i < PREVIEWS_PER_HOUR; i++) assert.equal((await get()).statusCode, 200);
  assert.equal((await get()).statusCode, 429);
});

// ── discord-link / unlink ───────────────────────────────────────────
await check("link: no session is 401", async () => {
  assert.equal((await link(userPost({ token: TOKEN }, null))).statusCode, 401);
  assert.equal(rpcCalls.length, 0);
});
await check("link: token goes to link_discord with this user; success message names the Discord", async () => {
  rpcResult = { data: { status: "ok", discord_username: "bob", entered_round: false }, error: null };
  const b = body(await link(userPost({ token: TOKEN, user_id: "someone-else" })));
  assert.deepEqual(rpcCalls, [["link_discord", { p_user: USER, p_token: TOKEN, p_code: null }]]);
  assert.equal(b.status, "ok");
  assert.equal(b.message, "Success! Discord linked as bob.");
  assert.equal((db.discord_link_attempts || []).length, 0);
});
await check("link: entered_round adds the Moai Drop line", async () => {
  rpcResult = { data: { status: "ok", discord_username: "bob", entered_round: true }, error: null };
  const b = body(await link(userPost({ token: TOKEN })));
  assert.equal(b.message, "Success! Discord linked as bob. You're entered in this week's Moai Drop.");
  assert.equal(b.entered_round, true);
});
await check("link: a typed code works, spaces ignored", async () => {
  rpcResult = { data: { status: "ok", discord_username: "bob" }, error: null };
  await link(userPost({ code: " 482 913 " }));
  assert.deepEqual(rpcCalls[0][1], { p_user: USER, p_token: null, p_code: "482913" });
});
await check("link: bad_link from the database is the expired line and counts as a try", async () => {
  rpcResult = { data: { status: "bad_link" }, error: null };
  const b = body(await link(userPost({ token: TOKEN })));
  assert.equal(b.status, "bad_link");
  assert.equal(b.message, "This link expired. Run /link in Discord for a fresh one.");
  assert.equal(db.discord_link_attempts.length, 1);
});
for (const bad of [{}, { token: "x" }, { code: "12345" }, { code: "abcdef" }, { token: 5 }]) {
  await check(`link: ${JSON.stringify(bad)} is bad_link, counted, never reaches the database`, async () => {
    const b = body(await link(userPost(bad)));
    assert.equal(b.status, "bad_link");
    assert.equal(db.discord_link_attempts.length, 1);
    assert.equal(rpcCalls.length, 0);
  });
}
await check("link: the 6th try in an hour is too_many, even with a good token", async () => {
  rpcResult = { data: { status: "bad_link" }, error: null };
  for (let i = 0; i < 5; i++) await link(userPost({ code: "000000" }));
  rpcCalls = []; rpcResult = { data: { status: "ok" }, error: null };
  const b = body(await link(userPost({ token: TOKEN })));
  assert.equal(b.status, "too_many");
  assert.equal(b.message, "Too many tries. Give it an hour.");
  assert.equal(rpcCalls.length, 0);
});
await check("link: database error is 500 with the try-again line", async () => {
  rpcResult = { data: null, error: { message: "boom" } };
  const r = await link(userPost({ token: TOKEN }));
  assert.equal(r.statusCode, 500);
  assert.equal(body(r).message, "Something went wrong. Try again in a minute.");
});
await check("unlink: clears all three columns for this user only", async () => {
  db.users = [{ id: USER, discord_id: DISCORD, discord_username: "bob", discord_linked_at: "x" }, { id: "other", discord_id: "9".repeat(18) }];
  const b = body(await unlink(userPost({})));
  assert.equal(b.message, "Discord unlinked.");
  assert.deepEqual(db.users[0], { id: USER, discord_id: null, discord_username: null, discord_linked_at: null });
  assert.equal(db.users[1].discord_id, "9".repeat(18));
  assert.equal((await unlink(userPost({}, null))).statusCode, 401);
});

// ── owner-only round endpoints ──────────────────────────────────────
const startBody = { invoker_discord_id: OWNER, guild_id: GUILD, channel_id: CHANNEL, prize: "30 day pass", bonus_days: 7 };
for (const [name, h, b] of [["create", create, startBody], ["message", setMessage, { round_id: 7, message_id: CHANNEL }],
  ["draw", draw, { guild_id: GUILD }], ["cancel", cancel, { guild_id: GUILD }]]) {
  await check(`${name}: the right secret with a non-owner invoker is 403 "just for the host"`, async () => {
    for (const invoker of ["1520166782013542423", "", undefined, OWNER + " "]) {
      const r = await h(botPost({ ...b, invoker_discord_id: invoker }));
      assert.equal(r.statusCode, 403);
      assert.equal(body(r).message, "This one's just for the host.");
    }
    assert.equal(rpcCalls.length, 0);
  });
  await check(`${name}: the owner with the wrong secret is 401`, async () => {
    assert.equal((await h(botPost({ ...b, invoker_discord_id: OWNER }, "nope"))).statusCode, 401);
  });
}
await check("create: a server not on GIVEAWAY_GUILD_IDS is refused", async () => {
  const r = await create(botPost({ ...startBody, guild_id: "222222222222222222" }));
  assert.equal(r.statusCode, 403);
  assert.equal(rpcCalls.length, 0);
});
await check("create: validates prize and days; defaults pass days to 30", async () => {
  for (const bad of [{ prize: "" }, { prize: "x".repeat(201) }, { bonus_days: 31 }, { bonus_days: 1.5 }, { pass_days: -1 }]) {
    assert.equal((await create(botPost({ ...startBody, ...bad }))).statusCode, 400, JSON.stringify(bad));
  }
  rpcResult = { data: { status: "ok", round_id: 7, week_start: "2026-10-12", draw_at: "2026-10-19T04:00:00+00:00" }, error: null };
  const b = body(await create(botPost(startBody)));
  assert.deepEqual(rpcCalls[0], ["create_giveaway_round", { p_guild: GUILD, p_channel: CHANNEL, p_prize: "30 day pass", p_pass_days: 30, p_bonus_days: 7 }]);
  assert.equal(b.round_id, 7);
  assert.match(b.post_text, /Bonus week: everyone who enters gets 7 free days\./);
  assert.match(b.post_text, /Sunday Oct 18 at 9 PM Pacific/);
});
await check("create: an open round already is 409 with the line", async () => {
  rpcResult = { data: { status: "already_open" }, error: null };
  const r = await create(botPost(startBody));
  assert.equal(r.statusCode, 409);
  assert.equal(body(r).message, MSG.alreadyOpen);
});
await check("message: saves the post id on the round", async () => {
  db.giveaway_rounds = [openRound()];
  assert.equal((await setMessage(botPost({ invoker_discord_id: OWNER, round_id: 7, message_id: "800000000000000009" }))).statusCode, 200);
  assert.equal(db.giveaway_rounds[0].message_id, "800000000000000009");
});
await check("draw: finds this server's open round and passes a crypto number under 2^48", async () => {
  db.giveaway_rounds = [openRound()];
  rpcResult = { data: { status: "ok", winner_discord_id: DISCORD, total_people: 3, total_entries: 13, spin_names: ["a"] }, error: null };
  const b = body(await draw(botPost({ invoker_discord_id: OWNER, guild_id: GUILD })));
  assert.equal(rpcCalls[0][0], "draw_giveaway");
  assert.equal(rpcCalls[0][1].p_round, 7);
  assert.ok(Number.isInteger(rpcCalls[0][1].p_r) && rpcCalls[0][1].p_r >= 0 && rpcCalls[0][1].p_r < 2 ** 48);
  assert.equal(b.winner_discord_id, DISCORD);
  assert.equal(b.round_id, 7);
});
await check("draw: no open round (or drawn already) is no_round", async () => {
  db.giveaway_rounds = [openRound({ status: "drawn" })];
  assert.equal(body(await draw(botPost({ invoker_discord_id: OWNER, guild_id: GUILD }))).status, "no_round");
  assert.equal(rpcCalls.length, 0);
  db.giveaway_rounds = [openRound()];
  rpcResult = { data: { status: "not_open" }, error: null };
  assert.equal(body(await draw(botPost({ invoker_discord_id: OWNER, guild_id: GUILD }))).status, "no_round");
});
await check("cancel: marks the open round cancelled and returns the post to disable", async () => {
  db.giveaway_rounds = [openRound({ message_id: "800000000000000009" })];
  const b = body(await cancel(botPost({ invoker_discord_id: OWNER, guild_id: GUILD })));
  assert.equal(b.status, "ok");
  assert.equal(b.message_id, "800000000000000009");
  assert.equal(db.giveaway_rounds[0].status, "cancelled");
  assert.equal(body(await cancel(botPost({ invoker_discord_id: OWNER, guild_id: GUILD }))).status, "no_round");
});

// ── enter / leave / status ──────────────────────────────────────────
const tap = (action, extra = {}) => enter(botPost({ action, round_id: 7, discord_id: DISCORD, discord_username: "bob", ...extra }));
await check("enter: secret required", async () => {
  assert.equal((await enter(botPost({ action: "enter", round_id: 7, discord_id: DISCORD }, "nope"))).statusCode, 401);
});
await check("enter while linked: entry saved, count is 1 + days this week", async () => {
  db.giveaway_rounds = [openRound()];
  db.users = [{ id: USER, discord_id: DISCORD }];
  db.user_active_days = [{ user_id: USER, day: pacificDate() }, { user_id: USER, day: pacificDate(new Date(Date.now() - 86_400_000)) }];
  const b = body(await tap("enter"));
  assert.equal(b.status, "entered");
  assert.equal(b.entries, 3);
  assert.equal(b.message, MSG.entered(2));
  assert.equal(db.giveaway_entries.length, 1);
  assert.equal(db.giveaway_entries[0].discord_username, "bob");
});
await check("enter twice = one entry", async () => {
  db.giveaway_rounds = [openRound()];
  db.users = [{ id: USER, discord_id: DISCORD }];
  await tap("enter"); await tap("enter");
  assert.equal(db.giveaway_entries.length, 1);
});
await check("enter while unlinked: entry saved, reply carries a link", async () => {
  db.giveaway_rounds = [openRound()];
  const b = body(await tap("enter"));
  assert.equal(b.status, "unlinked");
  assert.equal(b.message, MSG.unlinked);
  assert.match(b.link_url, /\/link-discord\?t=/);
  assert.equal(db.giveaway_entries.length, 1);
});
await check("enter again while unlinked reuses the live link (no limit burned)", async () => {
  db.giveaway_rounds = [openRound()];
  const urls = [];
  for (let i = 0; i < 5; i++) urls.push(body(await tap("enter")).link_url);
  assert.equal(new Set(urls).size, 1);
  assert.equal(db.discord_link_requests.length, 1);
});
await check("leave, then status: out; enter again: back in", async () => {
  db.giveaway_rounds = [openRound()];
  db.users = [{ id: USER, discord_id: DISCORD }];
  await tap("enter");
  const left = body(await tap("leave"));
  assert.equal(left.message, MSG.left);
  assert.ok(db.giveaway_entries[0].left_at);
  assert.equal(body(await tap("status")).status, "not_entered");
  assert.equal(body(await tap("enter")).status, "entered");
  assert.equal(db.giveaway_entries[0].left_at, null);
});
await check("after draw_at, or once drawn: 'draw is done', nothing saved", async () => {
  db.giveaway_rounds = [openRound({ draw_at: hoursFromNow(-0.01) })];
  const b = body(await tap("enter"));
  assert.equal(b.status, "closed");
  assert.equal(b.message, "This week's draw is done. Watch for next week's post.");
  assert.equal(db.giveaway_entries, undefined);
  db.giveaway_rounds = [openRound({ status: "drawn" })];
  assert.equal(body(await tap("enter")).status, "closed");
});
await check("cancelled round says so", async () => {
  db.giveaway_rounds = [openRound({ status: "cancelled" })];
  assert.equal(body(await tap("enter")).status, "cancelled");
});
await check("/entries: finds the server's open round without a round_id", async () => {
  db.giveaway_rounds = [openRound({ id: 3, status: "drawn" }), openRound()];
  db.users = [{ id: USER, discord_id: DISCORD }];
  assert.equal(body(await enter(botPost({ action: "status", guild_id: GUILD, discord_id: DISCORD }))).message, MSG.notEnteredLinked);
  db.users = [];
  assert.equal(body(await enter(botPost({ action: "status", guild_id: GUILD, discord_id: DISCORD }))).message, MSG.notEnteredUnlinked);
  db.giveaway_entries = [{ round_id: 7, discord_id: DISCORD, left_at: null }];
  assert.equal(body(await enter(botPost({ action: "status", discord_id: DISCORD }))).status, "unlinked");
  assert.equal(body(await enter(botPost({ action: "status", guild_id: "222222222222222222", discord_id: DISCORD }))).status, "no_round");
});
await check("enter: bad action or id is 400", async () => {
  assert.equal((await enter(botPost({ action: "win", round_id: 7, discord_id: DISCORD }))).statusCode, 400);
  assert.equal((await enter(botPost({ action: "enter", round_id: 7, discord_id: "bob" }))).statusCode, 400);
  assert.equal((await enter(botPost({ action: "enter", discord_id: DISCORD }))).statusCode, 400);
});

// ── nudge ───────────────────────────────────────────────────────────
await check("nudge: only rounds with someone unlinked, no tagging", async () => {
  rpcResult = { data: [{ round_id: 7, channel_id: CHANNEL, unlinked: 2 }, { round_id: 8, channel_id: "x", unlinked: 0 }], error: null };
  const b = body(await nudge(botPost({})));
  assert.deepEqual(b.nudges, [{ round_id: 7, channel_id: CHANNEL, message: MSG.nudge }]);
  assert.ok(!/<@/.test(MSG.nudge));
  assert.equal((await nudge(botPost({}, "nope"))).statusCode, 401);
});

console.log(`drop check: passed=${passed} failed=${failures.length}`);
if (failures.length) {
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("All Moai Drop checks passed.");
