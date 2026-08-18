// scripts/frame-check.mjs
// Frame / topic-routing regression harness — run: node scripts/frame-check.mjs
//
// Guards the word-boundary fixes for short cues (hardening CHANGE 11):
//   - "mg" fired inside "omg" → challenge at high confidence (could even
//     arm the Rumi beat)
//   - bare "sad" routed emotional messages ("I'm sad today, what should I
//     smoke") into CULTIVATION with a random diagnosis reference block
//
// frameDetect.js has no data-file dependency, but the shim stays consistent
// with the other harnesses in case that changes.
import assert from "node:assert";

const { detectFrame, classifyTopic, hasDiagnosisCue, routeVibeTurn } = await import("../lib/frameDetect.js");
const { searchHistory } = await import("../lib/historySearch.js");

// ── F01: "omg" is not a dosing question ──
assert.notStrictEqual(
  detectFrame("omg that's crazy", []).frame,
  "challenge",
  "F01: 'omg' must not trip the mg challenge cue"
);

// ── F02: real mg dosing still detects as challenge ──
assert.strictEqual(
  detectFrame("what dose should I try, like 5mg?", []).frame,
  "challenge",
  "F02: '5mg' must detect as challenge"
);

// ── F03: emotional "sad" is not a plant diagnosis ──
assert.notStrictEqual(
  classifyTopic("I'm sad today, what should I smoke"),
  "CULTIVATION",
  "F03: emotional 'sad' must not route to CULTIVATION"
);
assert.strictEqual(
  hasDiagnosisCue("I'm sad today"),
  false,
  "F03-b: emotional 'sad' is not a diagnosis cue"
);

// ── F04: plant-anchored "sad" still diagnoses ──
assert.strictEqual(
  classifyTopic("my plant looks sad and droopy"),
  "CULTIVATION",
  "F04: 'plant looks sad' must route to CULTIVATION"
);

// ═══ Vibe-tab routing (Early Update v2 §2) ═══════════════════════════
// routeVibeTurn is the exact function chat-send.js calls on every vibe turn.

// ── V01: philosophy is COMPLETELY untouched — test this hardest. ──
// classifyTopic returns its STRAIN catch-all for all of these, and the
// CULTIVATION cue list ("burn", "bug", "dying", " grow ") substring-matches
// several of them. Neither may ever fire a handoff on the vibe tab.
for (const msg of [
  "what's the point of anything",
  "money is stored time",
  "been thinking about tide pools and existence",
  "I'm burned out, man",
  "something's been bugging me for weeks",
  "I feel like I'm growing as a person",
  "part of me is dying and part of me is waking up",
  "what should I get my wife for her birthday",
  "I can't sleep, my mind won't stop",
]) {
  assert.strictEqual(
    routeVibeTurn(msg),
    "NONE",
    `V01: philosophy message must stay untouched: "${msg}"`
  );
}

// ── V02: real grow questions hand off ──
for (const msg of [
  "my leaves are yellowing on my blue dream plant",
  "is Blue Dream hard to grow?",
  "how do I grow weed at home",
]) {
  assert.strictEqual(routeVibeTurn(msg), "HANDOFF", `V02: grow question must hand off: "${msg}"`);
}

// ── V03: strain recommendations hand off ──
for (const msg of [
  "what's a good strain for chilling with my wife",
  "indica or sativa for movie night?",
  "what strain should I try",
]) {
  assert.strictEqual(routeVibeTurn(msg), "HANDOFF", `V03: strain rec must hand off: "${msg}"`);
}

// ── V04: consumption-safety answers IN PLACE — never a handoff. ──
// "took too much" previously matched NO safety cue and fell to the STRAIN
// catch-all; the person most in need of the safety route got nothing.
for (const msg of [
  "I took too much, I'm scared",
  "I'm freaking out, I got way too high",
  "I took too much of that strain", // trips both — safety must win
]) {
  assert.strictEqual(routeVibeTurn(msg), "SAFETY", `V04: safety must answer in place: "${msg}"`);
}

// ── V05: cannabis history is allowed AND grounded ──
assert.strictEqual(routeVibeTurn("who was Jack Herer"), "NONE", "V05: history question must not gate or hand off");
assert.ok(
  searchHistory("who was Jack Herer").length > 0,
  "V05-b: 'who was Jack Herer' must match the history database (grounded answer, not training memory)"
);
assert.strictEqual(routeVibeTurn("tell me about the war on drugs"), "NONE", "V05-c: history/culture stays on vibe");
assert.ok(
  searchHistory("tell me about the war on drugs").length > 0,
  "V05-d: 'war on drugs' must match the history database"
);

// ── V06: plant tab unchanged — safety-cue additions must not disturb the
// existing plant routes. ──
assert.strictEqual(classifyTopic("my plant looks sad and droopy"), "CULTIVATION", "V06: plant diagnosis unchanged");
assert.strictEqual(classifyTopic("what's good for a lazy sunday"), "STRAIN", "V06-b: strain talk unchanged");
assert.strictEqual(classifyTopic("I took too much of an edible"), "CONSUMPTION-SAFETY", "V06-c: overconsumption now routes to safety on plant too");

// ═══════════════════════════════════════════════════════════════════
// V07 — HISTORY INJECTION: the trigger requirement, actually enforced.
// ═══════════════════════════════════════════════════════════════════
//
// The filter read `score >= 3` with a comment saying "Require at least a
// trigger match." Nothing checked. A tag match (+1) plus a title-word match
// (+2) reaches 3 with ZERO trigger hits, so a generic shared word pulled a
// whole origin story. That is the July 26 diagnosis — written down, never
// shipped.
//
// Each message below was verified against the real dataset to score >= 3 with
// no trigger hit, so these are the actual false positives, not invented ones.
const { formatHistoryContext, recentHistoryIds } = await import("../lib/historySearch.js");

for (const [id, msg, why] of [
  ["V07-a", "i love that old reggae music my dad played",
    "hist_053 Bubba Kush — 'that' appears in the title"],
  ["V07-b", "the whole medical thing is confusing to me honestly",
    "hist_005 Prop 215 — one tag, one title word"],
  ["V07-c", "hemp rope is stronger than i expected",
    "hist_017 + hist_024 — 'hemp' in two titles"],
]) {
  assert.strictEqual(
    searchHistory(msg).length, 0,
    `${id}: "${msg}" must not inject history (was pulling ${why})`
  );
}

// ...and the trigger path is untouched. A requirement that also breaks real
// history questions has traded one bug for a worse one.
for (const [id, msg] of [
  ["V07-d", "who was Jack Herer"],
  ["V07-e", "tell me about the war on drugs"],
  ["V07-f", "what's the story with prop 215"],
  ["V07-g", "where did og kush come from"],
]) {
  const hits = searchHistory(msg);
  assert.ok(hits.length > 0, `${id}: "${msg}" must still match`);
  assert.ok(hits.every((h) => h.triggerHits > 0), `${id}: ...on a real trigger`);
}

// ═══════════════════════════════════════════════════════════════════
// V08 — HISTORY INJECTION: repeat suppression.
// ═══════════════════════════════════════════════════════════════════
//
// This is the actual "repeating." Nothing tracked which entries a user had
// already seen, so the same top-scoring entry won every time a similar word
// appeared. Scoring is deterministic — that's correct — which is exactly why
// suppression has to exist separately. Even with V07 fixed, a real trigger
// said twice surfaces the same entry twice.
{
  const first = searchHistory("tell me about the war on drugs");
  assert.ok(first.length > 0, "V08: setup — the first turn must match something");

  const block = formatHistoryContext(first);
  assert.ok(
    block.includes(`#${first[0].id}`),
    "V08-a: the injected block must stamp the entry ids it served"
  );

  // Replayed out of the stored augmented message, the way chat-send does it.
  const history = [
    { role: "user", content: "tell me about the war on drugs", content_augmented: "tell me about the war on drugs" + block },
    { role: "assistant", content: "man, that whole thing was never about the plant" },
  ];
  const seen = recentHistoryIds(history);
  assert.deepStrictEqual(
    seen, first.map((e) => e.id),
    "V08-b: the served ids must replay out of history"
  );

  const second = searchHistory("so what else about the war on drugs", { exclude: seen });
  assert.ok(
    !second.some((e) => seen.includes(e.id)),
    "V08-c: an entry already shown must not come back on the same trigger"
  );

  // Suppression is applied before scoring, so a suppressed top scorer cannot
  // block the runner-up that should surface in its place.
  const pool = searchHistory("tell me about the war on drugs", { exclude: ["definitely-not-an-id"] });
  assert.deepStrictEqual(
    pool.map((e) => e.id), first.map((e) => e.id),
    "V08-d: an irrelevant exclusion changes nothing"
  );

  // Degenerate inputs — this runs on every plant and vibe turn.
  assert.deepStrictEqual(recentHistoryIds([]), [], "V08-e: empty history");
  assert.deepStrictEqual(
    recentHistoryIds([{ role: "user", content: "hi" }]), [],
    "V08-f: a message with no augmented column"
  );
  assert.deepStrictEqual(
    recentHistoryIds([{ role: "user", content: "hi", content_augmented: "hi, no block here" }]), [],
    "V08-g: augmented content with no history block"
  );
  // The /g regex is stateful; two calls must agree.
  assert.deepStrictEqual(
    recentHistoryIds(history), recentHistoryIds(history),
    "V08-h: repeated calls must not drift on regex lastIndex"
  );
}

// ═══════════════════════════════════════════════════════════════════
// V09 — ADDENDUM D. The first bug report from a real user.
// ═══════════════════════════════════════════════════════════════════
//
// DJ Jedi, four days in, 50 messages on his heaviest day (previous single-day
// record: 19), unprompted: "I do notice that the weed strain stories keep
// repeating though." Volume made a latent bug visible.
//
// Reading historySearch turned up five defects, not one. The one that produced
// the repeating was the smallest to describe: EVERY match in the file was a
// substring test, and the OG Kush entry's `og` trigger matches inside
// pr-og-ress, rec-og-nize and l-og-ic. One entry won constantly on two-letter
// collisions, which is what "the same story keeps coming back" looks like from
// the outside.

// ── V09-a (D2): substring collisions. Each of these fired hist_001 (OG Kush)
// on main. `og` inside three different ordinary words. ──
for (const [id, msg, collision] of [
  ["V09-a1", "I've been making progress on something big", "og in progress"],
  ["V09-a2", "i recognize that feeling", "og in recognize"],
  ["V09-a3", "logic says one thing but my gut says another", "og in logic"],
  ["V09-a4", "that has a lot of potential honestly", "pot in potential"],
  ["V09-a5", "i posted it with a hashtag", "hash in hashtag"],
  ["V09-a6", "i found a place later that day", "la in place/later"],
  ["V09-a7", "been doing therapy for a while now", "rap in therapy"],
  ["V09-a8", "i saw it on facebook", "book in facebook"],
  ["V09-a9", "we drove to the spot", "pot in spot"],
]) {
  assert.strictEqual(
    searchHistory(msg).length, 0,
    `${id}: "${msg}" must not inject history (substring collision: ${collision})`
  );
}

// ── V09-b (C3): the July 26 mis-fire. A pure free-will/determinism question
// pulled the Chemdawg / OG Kush / Sour Diesel origin story. ──
assert.strictEqual(
  searchHistory("if every decision is based on past experiences do we ever really have free will").length,
  0,
  "V09-b: a philosophy question must not pull cannabis history (C3)"
);

// ── V09-c (C6/B3): the regression guard. D1-D3 tighten scoring a lot, which
// is the intent — but a tightening that also kills real history questions has
// traded one bug for a worse one. This is the guard the build order calls out:
// if these start failing, TITLE_BONUS_MAX is the dial to loosen first. ──
for (const [id, msg] of [
  ["V09-c1", "why is weed illegal in the first place"],   // B3, the named guard
  ["V09-c2", "who was Jack Herer"],
  ["V09-c3", "tell me about the war on drugs"],
  ["V09-c4", "what's the story with prop 215"],
  ["V09-c5", "where did og kush come from"],              // real `og kush`, not a collision
  ["V09-c6", "what happened with nixon and weed"],
  ["V09-c7", "tell me about the marihuana tax act"],
  ["V09-c8", "what's the deal with the emerald triangle"],
]) {
  const hits = searchHistory(msg);
  assert.ok(hits.length > 0, `${id}: "${msg}" must still match (C6/B3 regression guard)`);
  assert.ok(hits.every((h) => h.triggerHits > 0), `${id}: ...on a real trigger`);
}

// ── V09-d (D3): the title contribution is capped. It used to add +2 PER
// matching word with no ceiling, so a long message accumulated title points
// indefinitely. Repeating a title's words many times must not out-score a
// second trigger hit. ──
{
  const one = searchHistory("where did og kush come from");
  // Every content word below appears in "The Origin of OG Kush"; under the old
  // uncapped rule this would have scored far higher than the natural question.
  const stuffed = searchHistory("og kush origin origin kush kush origin kush og");
  const entry = one.find((e) => e.id === "hist_001");
  const stuffedEntry = stuffed.find((e) => e.id === "hist_001");
  assert.ok(entry && stuffedEntry, "V09-d: setup — hist_001 must match both phrasings");
  assert.ok(
    stuffedEntry.score - entry.score <= 4,
    `V09-d: title points must be capped; word-stuffing moved the score by ${stuffedEntry.score - entry.score}`
  );
}

console.log("frame-check: all assertions passed");
