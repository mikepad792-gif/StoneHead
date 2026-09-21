// scripts/similar-check.mjs
// "More like this" harness — run: node scripts/similar-check.mjs
//
// Drives api/strain-lookup.js in mode "similar" with the model call and the
// rate-limit RPC stubbed, and checks the one thing this feature can get wrong
// in a way nobody notices: INVENTED SIMILARITY.
//
// THE DISTINCTION THIS FILE EXISTS FOR
//
//   Describing the recommendation   any value in that strain's own record.
//   Claiming similarity             only values in the computed overlap.
//
// Source is Pine, Earthy, Citrus. Rec is Pine, Earthy, Sweet. The model may
// say the rec is sweet — that is true. It may NOT say they are both sweet —
// that is false, and it is the exact sentence a model writes when it is asked
// to find a similarity rather than handed one. Sweet is true of the strain and
// false of the relationship, and only the second one is a lie.
//
// Mechanical, no judgment: split into sentences, flag the ones that claim
// shared ground, and require every vocabulary word inside a flagged sentence
// to be in the passed shared lists. Unflagged sentences are unconstrained.
//
import assert from "node:assert";

process.env.AI_MODEL ||= "test/model";
process.env.SUPABASE_URL ||= "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-key";
process.env.OPENROUTER_API_KEY ||= "test-key";
process.env.BOT_SHARED_SECRET = "test-secret-value";

const { supabaseAdmin } = await import("../lib/supabase.js");
const { loadDataFile } = await import("../lib/dataFile.js");
const { handler } = await import("../api/strain-lookup.js");

const TABLE = loadDataFile("similar-strains.json");
const STRAINS = loadDataFile("strains.json");
const BY_NAME = new Map(STRAINS.map((r) => [String(r.Strain || "").trim(), r]));

const listOf = (v) =>
  String(v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x !== "None");

// ── Vocabulary ──────────────────────────────────────────────────────
// Built from the data rather than hardcoded, so a new flavor in a rebuilt
// strains.json is covered the day it lands instead of the day someone
// remembers this file exists.
const VOCAB = new Set();
for (const r of STRAINS) {
  for (const v of [...listOf(r.Effects), ...listOf(r.Flavor)]) {
    // "Spicy/Herbal" is one dataset value and two English words.
    for (const part of v.split("/")) if (part.trim()) VOCAB.add(part.trim().toLowerCase());
  }
}
// Type is a similarity claim too: "both indica" is exactly as checkable as
// "both earthy", and same_type is the field that licenses it.
for (const t of ["indica", "sativa", "hybrid"]) VOCAB.add(t);

/**
 * Reduce a vocabulary word to what a sentence might actually contain.
 *
 * The model writes "relaxing", not "Relaxed"; "earthy" survives as-is but
 * "Tingly" shows up as "tingle". Trimming a trailing -ed/-y and matching a
 * prefix covers the family without a stemmer. Kept conservative: a stem under
 * four characters keeps the whole word, so "Dry" does not become /dr\w*​/ and
 * swallow half the language.
 */
function stem(word) {
  const w = word.toLowerCase();
  for (const suffix of ["ed", "y"]) {
    if (w.endsWith(suffix)) {
      const cut = w.slice(0, -suffix.length);
      if (cut.length >= 4) return cut;
    }
  }
  return w;
}

const STEMS = new Map([...VOCAB].map((v) => [v, stem(v)]));

// Words that turn a description into a claim about the relationship. Straight
// from the spec. A couple of these ("too", "also") over-trigger in ordinary
// English, and that is the safe direction to be wrong in: over-triggering
// makes the check stricter, under-triggering lets the failure through.
const MARKERS = [
  /\bboth\b/i,
  /\bsame\b/i,
  /\balso\b/i,
  /\bshares?\b/i,
  /\bsharing\b/i,
  /\bsimilarly?\b/i,
  /\balike\b/i,
  /\blikewise\b/i,
  /\btoo\b/i,
  /\bmatching\b/i,
  /\bmatches\b/i,
  /\bas well\b/i,
];

/** Sentences, on terminal punctuation or a line break. */
function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check one reply against one overlap row.
 *
 * Strain names come out FIRST. "Blue Dream" and "Blueberry Haze" both contain
 * vocabulary words, and a sentence naming two strains would otherwise read as
 * a claim that they share blueness. The names are the subject of the sentence,
 * never the claim.
 *
 * @returns {{sentence: string, words: string[]}[]} one entry per violation
 */
export function findInventedSimilarity(reply, { sourceName, recName, shared }) {
  const sharedStems = new Set([...shared].map((s) => stem(String(s).toLowerCase())));

  const names = [sourceName, recName].flatMap((n) => [
    String(n),
    String(n).replace(/-+/g, " "),
  ]);
  const stripNames = (s) => {
    let out = s;
    for (const n of names) {
      if (!n) continue;
      // Word-bounded. A plain substring strip would eat the "Flo" out of
      // "flowery" and hide the very claim this function is looking for.
      out = out.replace(
        new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
        " "
      );
    }
    return out;
  };

  // "like <source>" is in the spec's marker list and cannot live in the static
  // table above: the source strain is only known per call. Tested against the
  // raw sentence, before the names are stripped out of it.
  const likeSource = names
    .filter(Boolean)
    .map((n) => new RegExp(`\\b(?:like|as)\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));

  const violations = [];
  for (const raw of sentences(reply)) {
    const marked =
      MARKERS.some((m) => m.test(raw)) || likeSource.some((m) => m.test(raw));
    if (!marked) continue; // unmarked: unconstrained
    const body = stripNames(raw);
    const words = [];
    for (const [word, st] of STEMS) {
      if (sharedStems.has(st)) continue;
      if (new RegExp(`\\b${st}\\w*`, "i").test(body)) words.push(word);
    }
    if (words.length) violations.push({ sentence: raw, words });
  }
  return violations;
}

/** The full shared vocabulary of one table row, as the prompt receives it. */
function sharedOf(row) {
  return [...(row.shared_effects || []), ...(row.shared_flavor || []), ...(row.same_type ? [row.same_type] : [])];
}

// ── S01: the table is ground truth, so prove it ─────────────────────
// Everything below trusts similar-strains.json. A stale table would make the
// whole check agree with itself and still be wrong, so the overlap is
// recomputed from strains.json for every row.
{
  let rows = 0;
  for (const [source, cands] of Object.entries(TABLE)) {
    const a = BY_NAME.get(source);
    assert(a, `S01a: table key ${source} is not in strains.json`);
    const aE = new Set(listOf(a.Effects));
    const aF = new Set(listOf(a.Flavor));
    const aType = String(a.Type ?? "").trim().toLowerCase();

    for (const c of cands) {
      const b = BY_NAME.get(c.strain);
      assert(b, `S01b: ${source} recommends ${c.strain}, which is not in strains.json`);

      const wantE = [...aE].filter((x) => new Set(listOf(b.Effects)).has(x));
      const wantF = [...aF].filter((x) => new Set(listOf(b.Flavor)).has(x));
      const bType = String(b.Type ?? "").trim().toLowerCase();
      const wantType = aType && aType === bType ? aType : null;

      assert.deepEqual(c.shared_effects, wantE, `S01c: ${source} → ${c.strain} shared_effects is stale`);
      assert.deepEqual(c.shared_flavor, wantF, `S01d: ${source} → ${c.strain} shared_flavor is stale`);
      assert.equal(c.same_type, wantType, `S01e: ${source} → ${c.strain} same_type is stale`);
      rows++;
    }
  }
  console.log(`  S01: ${Object.keys(TABLE).length} sources, ${rows} recommendations, overlap recomputed clean`);
}

// ── S02: the analyzer itself ────────────────────────────────────────
{
  const ctx = { sourceName: "Blue-Dream", recName: "Pineapple-Express", shared: ["Happy", "Sweet"] };

  assert.equal(
    findInventedSimilarity("Pineapple Express is earthy and hits hard.", ctx).length,
    0,
    "S02a: an unmarked sentence is unconstrained, even naming an unshared flavor"
  );
  assert.equal(
    findInventedSimilarity("They're both happy and sweet.", ctx).length,
    0,
    "S02b: a marked sentence using only shared values is fine"
  );
  assert.equal(
    findInventedSimilarity("They're both earthy.", ctx).length,
    1,
    "S02c: a marked sentence claiming an unshared flavor must fail"
  );
  assert.equal(
    findInventedSimilarity("Like Blue Dream, it's piney.", ctx).length,
    1,
    "S02d: 'like <source>' ties the claim to the source"
  );
  assert.equal(
    findInventedSimilarity("Blue Dream fans go for Pineapple Express. It's sweet.", ctx).length,
    0,
    "S02e: strain names are the subject, not a claim about blueness or pineapple"
  );
  assert.equal(
    findInventedSimilarity("It's relaxing too.", ctx).length,
    1,
    "S02f: 'too' is a shared-language marker"
  );
  assert.equal(
    findInventedSimilarity("Both are indica.", { ...ctx, shared: ["Happy"] }).length,
    1,
    "S02g: claiming a shared type with no same_type must fail"
  );
  assert.equal(
    findInventedSimilarity("Both are indica.", { ...ctx, shared: ["Happy", "indica"] }).length,
    0,
    "S02h: claiming a shared type IS allowed when same_type says so"
  );
  // "Like Blue Dream" with nothing else in it claims a likeness but names no
  // trait, so there is nothing mechanical to fail on. Recorded as a known
  // limit rather than pretended away: this check catches fabricated TRAITS,
  // not vagueness.
  assert.equal(
    findInventedSimilarity("Like Blue Dream, it's worth a go.", ctx).length,
    0,
    "S02i: a traitless likeness claim is out of scope for a mechanical check"
  );
}

// ── S03: scenarios generated from the data ──────────────────────────
// Cheap to write because the expected overlap comes straight from the table:
// for each pair, a clean reply built only from shared values and a dirty one
// built from a value that is true of the recommendation and NOT shared.
{
  let clean = 0;
  let caught = 0;
  let skipped = 0;

  for (const [source, cands] of Object.entries(TABLE).slice(0, 400)) {
    const row = cands[0];
    const shared = sharedOf(row);
    const rec = BY_NAME.get(row.strain);
    const unique = [...listOf(rec.Effects), ...listOf(rec.Flavor)].filter(
      (v) => !shared.includes(v)
    );
    if (!shared.length || !unique.length) { skipped++; continue; }

    const src = source.replace(/-+/g, " ");
    const name = row.strain.replace(/-+/g, " ");
    const ctx = { sourceName: source, recName: row.strain, shared };

    const ok = `${name} is the one. Both of them come through ${shared[0].toLowerCase()}. It also leans ${unique[0].toLowerCase()}.`;
    // ^ deliberately includes an "also" sentence about a UNIQUE trait, which
    //   is the sentence this check must not flag wrongly... except it does
    //   carry a marker, so it is split out below.
    const okSplit = `${name} is the one. Both of them come through ${shared[0].toLowerCase()}. It leans ${unique[0].toLowerCase()} on top of that.`;
    const bad = `${name} and ${src} are both ${unique[0].toLowerCase()}.`;

    assert.equal(
      findInventedSimilarity(okSplit, ctx).length,
      0,
      `S03a: clean reply for ${source} → ${row.strain} must pass`
    );
    const hits = findInventedSimilarity(bad, ctx);
    // "Spicy/Herbal" is one dataset value and two vocabulary words, so the
    // violation is reported against whichever part the sentence used.
    const parts = unique[0].toLowerCase().split("/").map((x) => x.trim());
    assert(
      hits.length === 1 && hits[0].words.some((w) => parts.includes(w.toLowerCase())),
      `S03b: invented similarity for ${source} → ${row.strain} must be caught, got ${JSON.stringify(hits)}`
    );
    // The "also + unique trait" shape IS a violation by the spec's rule, and
    // the check has to agree with itself about that.
    assert(
      findInventedSimilarity(ok, ctx).length >= 1,
      `S03c: "also <unique trait>" is a shared-language claim and must be caught`
    );
    clean++;
    caught++;
  }
  console.log(`  S03: ${clean} generated pairs, clean replies passed and invented ones caught (${skipped} skipped, no unique trait)`);
}

// ── Endpoint stubs ──────────────────────────────────────────────────
let noted = [];
supabaseAdmin.rpc = async (fn, args) => {
  if (fn === "begin_bot_lookup") return { data: [{ intro_claimed: false, recent: [] }], error: null };
  if (fn === "note_strain_shown") { noted.push(args.p_strain); return { data: null, error: null }; }
  return { data: true, error: null };
};

let lastRequest = null;
let modelReply = "Worth a look.";
globalThis.fetch = async (_url, init) => {
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

const call = (body) => {
  lastRequest = null;
  return handler({
    httpMethod: "POST",
    headers: { "x-bot-secret": "test-secret-value" },
    body: JSON.stringify(body),
  });
};
const ok = (res) => JSON.parse(res.body);
const userPrompt = () => lastRequest.messages.find((m) => m.role === "user").content;

const SIMILAR = { mode: "similar", discord_user_id: "901", guild_id: "902" };

// ── S04: the lists the prompt carries are the lists this check enforces ──
// The whole point. If the endpoint passed a different overlap than the table
// holds, every assertion above would still pass and the live feature would
// still invent similarities.
{
  const source = "Northern-Lights";
  // The first candidate that has a trait of its own. Romulan scores a perfect
  // 1.0 against Northern Lights and shares literally everything, which makes
  // it a fine recommendation and a useless fixture — there is no unique trait
  // left for a reply to misclaim.
  const row = TABLE[source].find((c) => {
    const b = BY_NAME.get(c.strain);
    const sh = new Set(sharedOf(c));
    return [...listOf(b.Effects), ...listOf(b.Flavor)].some((v) => !sh.has(v));
  });
  assert(row, "S04a: fixture source must have a candidate with a trait of its own");
  const rec = row.strain;

  await call({ ...SIMILAR, source_strain: source, rec_strain: rec });
  const prompt = userPrompt();

  const block = prompt.split(/SHARED WITH [^\n]*\n/)[1].split("\n")[0];
  const passed = block.split(",").map((x) => x.trim()).filter(Boolean);
  const expected = [
    ...(row.shared_effects || []),
    ...(row.shared_flavor || []),
    ...(row.same_type ? [`both ${row.same_type}`] : []),
  ];
  assert.deepEqual(passed, expected, `S04b: prompt's SHARED list must be the table's, got ${block}`);

  // And the unique list must NOT leak into it.
  const recRecord = BY_NAME.get(rec);
  const sharedSet = new Set(sharedOf(row));
  for (const v of [...listOf(recRecord.Effects), ...listOf(recRecord.Flavor)]) {
    if (sharedSet.has(v)) continue;
    assert(
      !passed.includes(v),
      `S04c: ${v} is unique to ${rec} and must not appear in the SHARED list`
    );
  }

  // Now run the analyzer against the same row, with a reply of the exact shape
  // this feature fails in.
  const unique = [...listOf(recRecord.Effects), ...listOf(recRecord.Flavor)].find(
    (v) => !sharedSet.has(v)
  );
  assert(unique, "S04d: fixture needs a trait unique to the recommendation");
  const hits = findInventedSimilarity(
    `${rec.replace(/-+/g, " ")} is the move. They're both ${unique.toLowerCase()}.`,
    { sourceName: source, recName: rec, shared: sharedOf(row) }
  );
  assert.equal(hits.length, 1, `S04e: invented "${unique}" must be caught against the live overlap`);
}

// ── S05: the endpoint cannot be driven into an arbitrary pair ───────
{
  // Unknown source: no candidates, and nothing invented to cover for it.
  assert.equal(
    (await call({ ...SIMILAR, source_strain: "Fhqwhgads" })).statusCode,
    404,
    "S05a: a source with no table entry must 404, not improvise"
  );
  assert.equal(
    (await call({ ...SIMILAR })).statusCode,
    400,
    "S05b: missing source_strain → 400"
  );
  // A rec that is real, and real similar to nothing in particular. Accepting
  // it would let a caller name any two strains and have them described as
  // alike, which is the failure the precompute exists to prevent.
  assert.equal(
    (await call({ ...SIMILAR, source_strain: "Northern-Lights", rec_strain: "Blue-Dream" })).statusCode,
    400,
    "S05c: a rec_strain outside the source's candidates must be refused"
  );

  // Every pick, over many taps, is one of that source's own candidates.
  const allowed = new Set(TABLE["Blue-Dream"].map((c) => c.strain));
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const res = ok(await call({ ...SIMILAR, source_strain: "Blue-Dream" }));
    assert(allowed.has(res.strain), `S05d: ${res.strain} is not a Blue-Dream candidate`);
    assert.equal(res.tier, "similar", "S05e: tier must say where the card came from");
    assert.equal(res.source_strain, "Blue-Dream", "S05f: the source must travel back");
    assert(res.strain_data, "S05g: a recommendation must carry its record");
    seen.add(res.strain);
  }
  assert(seen.size > 1, "S05h: 40 taps returning one strain means the pick is not random");

  // Recommendations are remembered, so a later no-match card does not offer
  // back the strain somebody just tapped through to.
  assert(noted.length > 0, "S05i: a recommendation must be recorded as shown");
}

// ── S06: nothing volunteered that the safety layers would intercept ──
// The layers read what a PERSON typed. A strain the endpoint chooses on its
// own never passes under them, and the database contains at least one name
// that trips the crisis detector.
{
  const { detectCrisis } = await import("../lib/crisisDetect.js");
  const { detectSubstance } = await import("../lib/substanceDetect.js");
  const { detectAge, belowFloor } = await import("../lib/ageDetect.js");

  const offered = new Set();
  for (const cands of Object.values(TABLE)) for (const c of cands) offered.add(c.strain);

  const bad = [...offered].filter((n) => {
    const t = n.replace(/-+/g, " ");
    return belowFloor(detectAge(t).band) || detectCrisis(t, []).tier > 0 || detectSubstance(t).tier > 0;
  });
  assert.equal(
    bad.length,
    0,
    `S06a: these names would be volunteered unprompted despite tripping a safety layer: ${bad.join(", ")}`
  );
  console.log(`  S06: ${offered.size} recommendable strains, none trip a safety layer`);
}

console.log("All similar-mode checks passed.");
