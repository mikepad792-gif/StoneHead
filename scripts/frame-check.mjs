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

console.log("frame-check: all assertions passed");
