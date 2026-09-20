// scripts/bot-lookup-check.mjs
// Discord strain-lookup harness — run: node scripts/bot-lookup-check.mjs
//
// Drives api/strain-lookup.js end to end with the model call and the rate-limit
// RPC stubbed, so every assertion below is about the endpoint's own decisions.
//
// The load-bearing test is B03/B04: a strain that is NOT in the database must
// come back matched:false with a MISS instruction and NO retrieved cards in the
// prompt. "Pink Thunder" retrieves three real Thunder strains on a loose score,
// and letting those through is how a bot invents a strain in public.
//
import assert from "node:assert";

// config.js throws at load when no model is configured, and supabase.js needs
// a URL to construct its client. Neither is reached — both calls are stubbed.
process.env.AI_MODEL ||= "test/model";
process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.OPENROUTER_API_KEY ||= "test-key";
process.env.BOT_SHARED_SECRET = "test-secret-value";

const { supabaseAdmin } = await import("../lib/supabase.js");
const { UNDER_13_REPLY } = await import("../lib/ageDetect.js");
const { CRISIS_REPLY } = await import("../lib/crisisDetect.js");
const { handler } = await import("../api/strain-lookup.js");

// ── Stubs ───────────────────────────────────────────────────────────
// ESM gives live bindings to the module's own object, and the endpoint holds
// the same instance, so replacing the method here replaces the one it calls.
let rateLimitResult = { data: true, error: null };
let introClaimed = false;   // what begin_bot_lookup reports
let recentStrains = [];     // what it hands back as already-seen
let notedStrains = [];      // what note_strain_shown was asked to record

supabaseAdmin.rpc = async (fn, args) => {
  if (fn === "begin_bot_lookup") {
    return { data: [{ intro_claimed: introClaimed, recent: recentStrains }], error: null };
  }
  if (fn === "note_strain_shown") {
    notedStrains.push(args.p_strain);
    return { data: null, error: null };
  }
  return rateLimitResult;
};

// openrouter.js calls global fetch. Capture what the model was asked, so the
// prompt itself can be asserted on and not just the reply.
let lastRequest = null;
let fetchCalls = 0;
let modelReply = "Blue Dream, yeah. That one's a classic.";
globalThis.fetch = async (_url, init) => {
  fetchCalls++;
  lastRequest = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: "test/model",
      choices: [{ message: { content: modelReply }, finish_reason: "stop" }],
    }),
  };
};

const SECRET_HEADERS = { "x-bot-secret": "test-secret-value" };

function call(body, { headers = SECRET_HEADERS, method = "POST" } = {}) {
  fetchCalls = 0;
  lastRequest = null;
  return handler({ httpMethod: method, headers, body: JSON.stringify(body) });
}

const ok = (res) => JSON.parse(res.body);
/** The user-role content the model was handed — where the MISS block lands. */
const userPrompt = () => lastRequest.messages.find((m) => m.role === "user").content;
const systemPrompt = () => lastRequest.messages.find((m) => m.role === "system").content;

const LOOKUP = { query: "blue dream", discord_user_id: "111", guild_id: "222" };

// ── B01: method and auth ────────────────────────────────────────────
assert.equal((await call(LOOKUP, { method: "GET" })).statusCode, 405, "B01a: GET must be 405");
assert.equal((await call(LOOKUP, { headers: {} })).statusCode, 401, "B01b: no secret must be 401");
assert.equal(
  (await call(LOOKUP, { headers: { "x-bot-secret": "wrong" } })).statusCode,
  401,
  "B01c: wrong secret must be 401"
);

// An UNSET secret must refuse everything rather than fall open. The repo is
// public: an unauthenticated version of this endpoint is a free ride on the
// OpenRouter balance.
const realSecret = process.env.BOT_SHARED_SECRET;
delete process.env.BOT_SHARED_SECRET;
assert.equal((await call(LOOKUP)).statusCode, 401, "B01d: unset BOT_SHARED_SECRET must fail closed");
process.env.BOT_SHARED_SECRET = realSecret;

// ── B02: input validation ───────────────────────────────────────────
assert.equal((await call({ ...LOOKUP, query: "   " })).statusCode, 400, "B02a: blank query → 400");
assert.equal((await call({ ...LOOKUP, query: "x".repeat(201) })).statusCode, 400, "B02b: >200 chars → 400");
assert.equal(
  (await call({ query: "blue dream", discord_user_id: "" })).statusCode,
  400,
  "B02c: missing discord_user_id → 400"
);

// ── B03: a real strain resolves and carries context ─────────────────
const hit = ok(await call(LOOKUP));
assert.equal(hit.matched, true, "B03a: 'blue dream' must match");
assert.equal(hit.strain, "Blue-Dream", `B03b: expected Blue-Dream, got ${hit.strain}`);
assert(userPrompt().includes("STRAIN CONTEXT"), "B03c: a hit must carry retrieved cards");
assert(!userPrompt().includes("STRAIN LOOKUP: MISS"), "B03d: a hit must NOT be marked a miss");
assert(systemPrompt().includes("ONE-SHOT LOOKUP"), "B03e: the Discord note must be in the system prompt");

// ── B03f: the output budget stays above the documented floor ────────
//
// MAX_TOKENS' documentation sets a floor of ~600: a model that front-loads
// hidden reasoning scaffold spends the budget before the real reply starts, so
// a LOW ceiling causes the truncation it looks like it prevents. This endpoint
// shipped at 500 once. The clamp and this assertion are why it can't again.
assert(
  lastRequest.max_tokens >= 600,
  `B03f: max_tokens must stay >= 600, got ${lastRequest.max_tokens}`
);
assert.equal(
  lastRequest.reasoning?.enabled,
  false,
  "B03g: reasoning must be disabled at the source"
);

// An override under the floor is clamped up, not honored — a silent truncation
// bug is worse than an ignored env var.
process.env.BOT_MAX_TOKENS = "120";
const { handler: reHandler } = await import("../api/strain-lookup.js?clamp");
await reHandler({
  httpMethod: "POST",
  headers: SECRET_HEADERS,
  body: JSON.stringify(LOOKUP),
});
assert(
  lastRequest.max_tokens >= 600,
  `B03h: BOT_MAX_TOKENS=120 must clamp up to the floor, got ${lastRequest.max_tokens}`
);
delete process.env.BOT_MAX_TOKENS;

// ── B03i: the bot rides its own model variable ──────────────────────
//
// AI_MODEL_BOT exists so the free public bot and the signed-in product can
// diverge on cost without a code change. Unset, it inherits AI_MODEL — which
// is the state it shipped in, and the assertion that keeps "separate variable"
// from quietly meaning "separate default".
assert.equal(
  lastRequest.model,
  process.env.AI_MODEL,
  `B03i: blank AI_MODEL_BOT must inherit AI_MODEL, got ${lastRequest.model}`
);

// The override has to be checked in a FRESH PROCESS. config.js resolves every
// model at module load on purpose — a misconfigured deploy should fail loudly
// at cold start rather than serve traffic on an unintended endpoint — so an
// env var set after import is not read, and a same-process test would assert
// something Netlify never does. A subprocess is a cold start.
const { execFileSync } = await import("node:child_process");
const probe = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const c = await import("${new URL("../lib/config.js", import.meta.url).href}");
       console.log(JSON.stringify({ bot: c.AI_MODEL_BOT, chat: c.AI_MODEL_CHAT }));`,
    ],
    {
      env: { ...process.env, AI_MODEL_BOT: "some-vendor/cheap-model" },
      encoding: "utf-8",
    }
  )
);

assert.equal(
  probe.bot,
  "some-vendor/cheap-model",
  `B03j: AI_MODEL_BOT must override, got ${probe.bot}`
);
assert.equal(
  probe.chat,
  process.env.AI_MODEL,
  `B03k: setting AI_MODEL_BOT must not move the chat model, got ${probe.chat}`
);

// ── B03l: strain_data carries the record the bot renders ────────────
//
// Additive to the response. reply/matched/strain keep their shape, because a
// bot deploy and a function deploy do not land at the same moment.
const dataHit = ok(await call({ ...LOOKUP, query: "blue dream" }));
assert.equal(dataHit.strain, "Blue-Dream", "B03l: sanity — the fixture still resolves");
assert.equal(dataHit.strain_data.type, "hybrid", "B03m: type comes from the record");
assert.equal(dataHit.strain_data.rating, 4.4, "B03n: rating comes from the record");
assert.deepEqual(
  dataHit.strain_data.effects,
  ["Relaxed", "Happy", "Uplifted", "Euphoric", "Creative"],
  "B03o: effects split on commas, case preserved"
);
assert.deepEqual(
  dataHit.strain_data.flavor,
  ["Blueberry", "Berry", "Sweet"],
  "B03p: flavor split on commas"
);

// Case matters: normalizeList() lowercases for scoring, which is right there
// and wrong in a field a person reads.
assert(
  dataHit.strain_data.effects.every((e) => e[0] === e[0].toUpperCase()),
  "B03q: effects must NOT be lowercased for display"
);

// A sparse record still produces a usable object. 87 records carry
// Effects:"None" and 156 an absent Flavor; those travel as empty arrays so the
// bot skips the field rather than rendering an empty box.
const sparse = ok(await call({ ...LOOKUP, query: "3 bears og" }));
if (sparse.matched) {
  assert.deepEqual(sparse.strain_data.effects, [], "B03r: Effects:'None' becomes []");
  assert.deepEqual(sparse.strain_data.flavor, [], "B03s: absent Flavor becomes []");
  assert.equal(sparse.strain_data.rating, 0, "B03t: an unrated record keeps its 0");
}

// SUPERSEDED BY ALWAYS-A-CARD. A miss used to carry strain_data:null because
// it carried no card at all. It now carries a tier C card, so the invariant
// moves: strain_data is never a HALF-FILLED object, and it always describes
// whatever `strain` names. Those two together are what stop the embed fields
// and the prose disagreeing — which was the original point of the assertion.
const dataMiss = ok(await call({ ...LOOKUP, query: "pink thunder" }));
assert.equal(dataMiss.matched, false, "B03u: a miss still reports matched:false");
assert(
  dataMiss.strain && dataMiss.strain_data,
  "B03u2: and now carries a real card rather than an apology"
);
assert(
  dataMiss.strain_data.type,
  "B03u3: the card is populated, not a shell with a name on it"
);

// A safety turn is the case that still carries nothing, and must.
const safetyNoCard = ok(await call({ ...LOOKUP, query: "i want to kill myself" }));
assert.equal(safetyNoCard.strain_data, null, "B03u4: a safety turn carries no record");

// The three keys the deployed bot already depends on are untouched.
for (const key of ["reply", "matched", "strain"]) {
  assert(key in dataHit, `B03v: ${key} must still be present`);
}

// ── B03w: a confident misspelling is answered, and announced ────────
//
// "northen lights" scores 0.933. Above the 0.92 bar the lookup answers for
// the corrected strain instead of spending one of the user's ten hourly
// lookups on "did you mean".
const corrected = ok(await call({ ...LOOKUP, query: "northen lights" }));
assert.equal(corrected.matched, true, "B03w: a high-confidence correction must resolve");
assert(corrected.strain, "B03x: it must report the corrected strain");
assert(
  /northern/i.test(corrected.strain),
  `B03y: expected a Northern Lights record, got ${corrected.strain}`
);

// The invariant that keeps this from being Pink Thunder again: the prompt is
// TOLD to announce the swap, and the cards are the real record for the strain
// being answered, so the embed fields cannot describe a different strain
// from the prose.
assert(
  /SPELLING, AND YOU SAY SO/.test(userPrompt()),
  "B03z: a corrected answer must instruct the model to name the correction"
);
assert(
  userPrompt().includes("northen lights"),
  "B03aa: the note must carry what the user actually typed"
);
assert(userPrompt().includes("STRAIN CONTEXT"), "B03ab: real cards must be retrieved");
assert(
  corrected.strain_data && corrected.strain_data.type,
  "B03ac: strain_data must describe the strain actually answered"
);

// ── B03ad: below the bar, offered but not claimed ───────────────────
//
// SUPERSEDED BY ALWAYS-A-CARD. "gorilla glue" scores 0.846 against
// Godzilla-Glue: still nowhere near enough to answer through, but no longer a
// bare "did you mean". It now comes back as a candidate WITH a card, because
// a question that spends one of ten hourly lookups and returns nothing is a
// worse outcome than an offer the reply is honest about.
//
// What carried over from the old assertions is the half that matters: it does
// not resolve, and it does not get the answer-through note.
const unsure = ok(await call({ ...LOOKUP, query: "gorilla glue" }));
assert.equal(unsure.matched, false, "B03ae: a low-confidence correction must NOT resolve");
assert.equal(unsure.tier, "candidate", `B03af: it is a candidate, got ${unsure.tier}`);
assert(
  /NO EXACT MATCH, ONE NEAR THING/.test(userPrompt()),
  "B03ag: it is offered as a near thing, not claimed"
);
assert(
  !/SPELLING, AND YOU SAY SO/.test(userPrompt()),
  "B03ah: and must not get the answer-through note"
);
assert(
  unsure.strain && unsure.strain_data,
  "B03ai: the candidate card is real, not an apology"
);

// A real miss with no near-neighbour is still a miss in the only sense that
// counts: matched stays false and the card is announced as something else.
const stillMiss = ok(await call({ ...LOOKUP, query: "pink thunder" }));
assert.equal(stillMiss.matched, false, "B03aj: pink thunder is still not a match");
assert.equal(stillMiss.tier, "unrelated", `B03ak: and lands on tier C, got ${stillMiss.tier}`);

// ── B03al: long dashes never reach the user ─────────────────────────
//
// The prompt rule did not hold in production, so the guarantee is in code.
modelReply = "that one's a classic — hits fast, hits hard — and the diesel is real.";
const dashed = ok(await call(LOOKUP));
assert(
  !/[\u2014\u2013]/.test(dashed.reply),
  `B03am: no em or en dash may survive, got ${JSON.stringify(dashed.reply)}`
);
assert(
  dashed.reply.includes("a classic, hits fast"),
  `B03an: the dash becomes the comma it stood for, got ${JSON.stringify(dashed.reply)}`
);

modelReply = "trailing off... stays, and a 4\u20136 hour range stays a range.";
const kept = ok(await call(LOOKUP));
assert(kept.reply.includes("..."), "B03ao: ellipses are part of the voice and survive");
assert(kept.reply.includes("4-6 hour"), `B03ap: a numeric range becomes a hyphen, got ${JSON.stringify(kept.reply)}`);
modelReply = "Blue Dream, yeah. That one's a classic.";

// ── B04: THE ONE THAT MATTERS — a strain that does not exist ────────
//
// searchStrains("pink thunder") returns Alaska-Thunder-Grape, Dutch-Thunder-
// Fuck and Cherry-Thunder-Fuck on a shared-token score. None of them is Pink
// Thunder. Reporting a match here, or handing those cards to the model, is the
// failure this endpoint exists to not have.
//
// UPDATED for always-a-card. These queries now DO return a card, so the old
// "strain must be null" and "no cards" assertions are gone — deliberately,
// they described the apology this update replaced. What has NOT changed, and
// is the whole point, is that none of these is reported as the strain the
// person asked for, and the loose near-neighbours never reach the model.
for (const fake of ["pink thunder", "blue smog", "gorilla glue"]) {
  const miss = ok(await call({ ...LOOKUP, query: fake }));
  assert.equal(miss.matched, false, `B04a: "${fake}" must NOT report a match`);
  assert(
    miss.tier === "candidate" || miss.tier === "unrelated",
    `B04b: "${fake}" must land on an offering tier, got ${miss.tier}`
  );
  assert(
    /NO EXACT MATCH, ONE NEAR THING|NO MATCH AT ALL, AND THE CARD IS SOMETHING ELSE/.test(
      userPrompt()
    ),
    `B04c: "${fake}" must carry a note saying the card is not their strain`
  );
}

// The actual Pink Thunder mechanism, closed: three Thunder cards sitting in
// the context window under the user's query, one of which gets described as
// theirs. Tier C hands over exactly the card it picked and drops every loose
// near-neighbour searchStrains found.
//
// Asserted structurally rather than by naming the Thunder strains, because the
// pick is random and naming them would flake once every few thousand runs.
const thunder = ok(await call({ ...LOOKUP, query: "pink thunder" }));
const cardNames = [
  ...userPrompt().matchAll(/\n([A-Za-z0-9-]+) \((indica|sativa|hybrid)\)/g),
].map((m) => m[1]);
assert.deepEqual(
  cardNames,
  [thunder.strain],
  `B04d: tier C must hand over only its own card, got ${JSON.stringify(cardNames)}`
);

// A bare common word is ambiguous, not a match — "/strain purple" resolving to
// Purple-Ak-47 is a fabrication with extra steps.
const vague = ok(await call({ ...LOOKUP, query: "purple" }));
assert.equal(vague.matched, false, "B04e: a bare common word must not resolve to a random strain");

// ── B05: names the strict resolver alone would false-miss ───────────
// Both are shapes a person actually types, and "chem's sister" is the bot's
// own documented example.
for (const [q, expected] of [["chem's sister", "Chems-Sister"], ["blue dream effects", "Blue-Dream"]]) {
  const res = ok(await call({ ...LOOKUP, query: q }));
  assert.equal(res.matched, true, `B05a: "${q}" must match`);
  assert.equal(res.strain, expected, `B05b: "${q}" → expected ${expected}, got ${res.strain}`);
}

// ── B06: safety intercepts, and what they cost ──────────────────────
const under13 = ok(await call({ ...LOOKUP, query: "im 11 and want to try weed" }));
assert.equal(under13.reply, UNDER_13_REPLY, "B06a: below the floor returns the fixed reply");
assert.equal(fetchCalls, 0, "B06b: below the floor must not call the model");

const crisis = ok(await call({ ...LOOKUP, query: "i want to kill myself" }));
assert(crisis.reply.startsWith(CRISIS_REPLY.slice(0, 40)), "B06c: tier 2 returns CRISIS_REPLY");
assert.equal(fetchCalls, 0, "B06d: tier 2 must not call the model");
assert(crisis.reply.length > CRISIS_REPLY.length, "B06e: the resources must be appended to the text");
assert(/988|crisis|text/i.test(crisis.reply), "B06f: the reply must carry a reachable resource");
assert.equal(crisis.matched, false, "B06g: a safety turn is never a strain match");

// A firing substance turn answers under the substance prompt, not the plant
// prompt, and never with a strain card.
const subst = ok(await call({ ...LOOKUP, query: "i took a bunch of xanax and i feel weird" }));
assert.equal(subst.matched, false, "B06h: a substance turn is never a strain match");
assert(!systemPrompt().includes("ONE-SHOT LOOKUP"), "B06i: a substance turn must not run the plant prompt");

// ── B07: rate limiting ──────────────────────────────────────────────
rateLimitResult = { data: false, error: null };
assert.equal((await call(LOOKUP)).statusCode, 429, "B07a: over the cap → 429");
assert.equal(fetchCalls, 0, "B07b: over the cap must not call the model");

// A counter that ERRORS fails closed — it is not a reason to serve free model
// calls on a public endpoint.
rateLimitResult = { data: null, error: { message: "connection refused" } };
assert.equal((await call(LOOKUP)).statusCode, 429, "B07c: a broken counter must fail closed");
assert.equal(fetchCalls, 0, "B07d: a broken counter must not call the model");

// But the disclosure is not allowed to depend on somebody's hourly budget: a
// safety turn over quota still gets its fixed reply and its resources.
const overQuotaCrisis = ok(await call({ ...LOOKUP, query: "i want to kill myself" }));
assert(
  overQuotaCrisis.reply.startsWith(CRISIS_REPLY.slice(0, 40)),
  "B07e: a crisis turn over quota must still be answered, not 429'd"
);
rateLimitResult = { data: true, error: null };

// ── B08: the endpoint writes nothing ────────────────────────────────
// Stateless by contract: no users, no threads, no messages, no vibe tab.
const src = await (await import("node:fs/promises")).readFile(
  new URL("../api/strain-lookup.js", import.meta.url),
  "utf-8"
);
assert(!/supabaseAdmin\s*\.\s*from\s*\(/.test(src), "B08a: must not read or write any table directly");
assert(!/\.(insert|upsert|update|delete)\s*\(/.test(src), "B08b: must not write rows");
assert(!/vibe/i.test(src), "B08c: the vibe tab belongs behind an account");
assert(/bump_bot_usage/.test(src), "B08d: the rate limiter must go through the atomic RPC");

// The route has to exist, or every lookup resolves to the SPA fallback and the
// bot gets index.html with a 200.
const toml = await (await import("node:fs/promises")).readFile(
  new URL("../netlify.toml", import.meta.url),
  "utf-8"
);
const routeIdx = toml.indexOf('from = "/api/strain-lookup"');
assert(routeIdx > 0, "B08e: netlify.toml must route /api/strain-lookup");
assert(routeIdx < toml.indexOf('from = "/*"'), "B08f: the route must sit above the SPA fallback");

// ── B09: every tier returns a card ──────────────────────────────────
//
// A miss used to spend one of ten hourly lookups to return an apology. Each
// tier now ends with a card, and each keeps `matched` honest about whether
// that card is the strain the person asked for.
for (const [q, wantTier, wantMatched] of [
  ["blue dream", "exact", true],
  ["northen lights", "corrected", true],
  ["skittlez", "candidate", false],
  ["fhqwhgads", "unrelated", false],
]) {
  const res = ok(await call({ ...LOOKUP, query: q }));
  assert.equal(res.tier, wantTier, `B09a: "${q}" should be tier ${wantTier}, got ${res.tier}`);
  assert.equal(res.matched, wantMatched, `B09b: "${q}" matched should be ${wantMatched}`);
  assert(res.strain, `B09c: "${q}" must return a card, got strain=${res.strain}`);
  assert(res.strain_data, `B09d: "${q}" must return strain_data`);
  assert(userPrompt().includes("STRAIN CONTEXT"), `B09e: "${q}" must get real cards`);
}

// ── B10: an offer is never dressed as an answer ─────────────────────
//
// The Pink Thunder line, restated for the tiers that hand over a strain the
// person did not ask for. A card is not a claim. A card presented as THEIR
// strain when it isn't, is.
ok(await call({ ...LOOKUP, query: "skittlez" }));
assert(
  /NO EXACT MATCH, ONE NEAR THING/.test(userPrompt()),
  "B10a: a candidate must be told to offer, not answer"
);
assert(userPrompt().includes("skittlez"), "B10b: the note carries what they typed");

ok(await call({ ...LOOKUP, query: "fhqwhgads" }));
assert(
  /NO MATCH AT ALL, AND THE CARD IS SOMETHING ELSE/.test(userPrompt()),
  "B10c: an unrelated card must break the two halves apart"
);
assert(
  /NOTHING to do with what they asked for/.test(userPrompt()),
  "B10d: and say outright the card is not their strain"
);

// ── B11: the no-match card does not repeat ──────────────────────────
recentStrains = [];
const picked = [];
for (let i = 0; i < 12; i++) {
  const res = ok(await call({ ...LOOKUP, query: `zzqqxx${i}` }));
  picked.push(res.strain);
  recentStrains = [res.strain, ...recentStrains].slice(0, 20);
}
assert.equal(
  new Set(picked).size,
  picked.length,
  `B11a: no-match cards must not repeat inside the memory, got ${JSON.stringify(picked)}`
);

// Every tier records what it showed, not just the no-match one: a strain seen
// through an ordinary lookup is just as stale a suggestion later.
notedStrains = [];
ok(await call({ ...LOOKUP, query: "blue dream" }));
assert(
  notedStrains.includes("Blue-Dream"),
  `B11b: an exact hit is recorded as shown too, got ${JSON.stringify(notedStrains)}`
);

// ── B12: the intro is claimed, never decided locally ────────────────
//
// begin_bot_lookup claims it atomically, so a burst of first lookups still
// introduces once. The endpoint only reports what the claim returned.
introClaimed = true;
ok(await call({ ...LOOKUP, query: "blue dream" }));
assert(/FIRST TIME/.test(userPrompt()), "B12a: a claimed intro reaches the prompt");
introClaimed = false;
ok(await call({ ...LOOKUP, query: "blue dream" }));
assert(!/FIRST TIME/.test(userPrompt()), "B12b: an unclaimed intro does not");

// ── B13: safety turns never get a card ──────────────────────────────
//
// A random strain stapled to a crisis reply would be grotesque. These paths
// return before any tier logic runs; this keeps it that way.
for (const q of ["i want to kill myself", "im 11 and want to try weed"]) {
  const res = ok(await call({ ...LOOKUP, query: q }));
  assert.equal(fetchCalls, 0, `B13a: "${q}" must not call the model`);
  assert.equal(res.strain, null, `B13b: "${q}" must carry no strain`);
  assert(!res.tier, `B13c: "${q}" must carry no tier, got ${res.tier}`);
}
ok(await call({ ...LOOKUP, query: "i took a bunch of xanax and i feel weird" }));
assert(
  !/STRAIN CONTEXT/.test(userPrompt()),
  "B13d: a substance turn must not be handed strain cards"
);

// ── B14: a no-match card can always be tapped for more ──────────────
//
// The pool filter matches build-similar-strains.mjs on purpose, so every
// strain offered here is also a key in the similar table. Without that,
// "more like this" would die on the path most likely to be tapped.
const { readFile } = await import("node:fs/promises");
const similarRaw = await readFile(
  new URL("../data/similar-strains.json", import.meta.url),
  "utf-8"
).catch(() => null);
if (similarRaw) {
  const similarTable = JSON.parse(similarRaw);
  recentStrains = [];
  const orphans = [];
  for (let i = 0; i < 40; i++) {
    const res = ok(await call({ ...LOOKUP, query: `qqzz${i}` }));
    if (res.strain && !similarTable[res.strain]) orphans.push(res.strain);
  }
  assert.equal(
    orphans.length,
    0,
    `B14a: every no-match card needs similar-strains entries, missing: ${JSON.stringify(orphans.slice(0, 5))}`
  );
}

console.log("All bot lookup checks passed.");
