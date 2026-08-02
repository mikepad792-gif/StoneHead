// scripts/save-intent-check.mjs
// Save-intent + title-validation regression harness.
// Run: node scripts/save-intent-check.mjs
//
// Guards the two "wrong input" bug classes from the live diagnosis:
//   - strain-save capturing sentence fragments ("You Didn T Save It",
//     "Grandaddy Purp As A Liked") and mangling apostrophes
//   - the thread titler accepting non-titles (scaffold, code lines,
//     conversational fragments) and freezing threads on garbage
//
import assert from "node:assert";

// lib/likedStrains.js imports the supabase client, which insists on env vars
// at import time. The functions under test never touch the network — dummies
// keep the import happy.
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ||= "check-dummy";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "check-dummy";
// Same deal for lib/config.js (reached via titleGen): an unresolvable model is
// a config error and throws at import. No model is called here.
process.env.AI_MODEL ||= "check-dummy/model";

const { detectSaveIntent } = await import("../lib/saveIntent.js");
const { escapeLikePattern, lookupStrainType } = await import("../lib/likedStrains.js");
const { looksLikeTitle, buildTitleTranscript } = await import("../lib/titleGen.js");
const { BLANK_REPLY_FALLBACK } = await import("../lib/constants.js");

// ── S01: sentence fragments must NOT be saved ──
assert.strictEqual(
  detectSaveIntent("you didn't save it"),
  null,
  "S01: 'you didn't save it' must not save anything"
);
assert.strictEqual(
  detectSaveIntent("why didnt you remember that"),
  null,
  "S01-b: intent scaffolding must not save anything"
);
assert.strictEqual(
  detectSaveIntent("save my progress"),
  null,
  "S01-c: non-strain object must not save anything"
);

// ── S02: a real strain buried in sentence scaffolding still saves ──
const s2 = detectSaveIntent("bro you didn't save blue dream for me");
assert(
  s2 && /blue.?dream/i.test(s2.value.strain_name),
  `S02: embedded 'blue dream' must still resolve, got ${JSON.stringify(s2)}`
);

// ── S03: '"as a liked strain" tails never end up inside the name ──
const s3 = detectSaveIntent("save grandaddy purp as a liked strain");
assert(
  s3 && /^grandaddy purp$/i.test(s3.value.strain_name.trim()),
  `S03: expected literal 'Grandaddy Purp' with the tail stripped, got ${JSON.stringify(s3)}`
);

// ── S04: apostrophes survive the literal-save path ──
const s4 = detectSaveIntent("save razzle's dazzle for me");
assert(
  s4 && s4.value.strain_name === "Razzle's Dazzle",
  `S04: apostrophe must survive ("Razzle's Dazzle"), got ${JSON.stringify(s4)}`
);

// ── S05: the clean case still works ──
const s5 = detectSaveIntent("remember i love northern lights");
assert(
  s5 && /northern.?lights/i.test(s5.value.strain_name),
  `S05: 'northern lights' must resolve, got ${JSON.stringify(s5)}`
);

// ── T01: title validator rejects every observed failure shape ──
assert(!looksLikeTitle(""), "T01-a: empty title rejected");
assert(!looksLikeTitle("import re, sys, json"), "T01-b: code line rejected");
assert(!looksLikeTitle("If youre looking for"), "T01-c: conversational fragment rejected");
assert(!looksLikeTitle("Does that make sense"), "T01-d: question fragment rejected");
assert(!looksLikeTitle("user: hey what strain"), "T01-e: role label rejected");
assert(
  !looksLikeTitle("one two three four five six seven eight nine"),
  "T01-f: run-on rejected"
);

// ── T02: real titles pass ──
assert(looksLikeTitle("Northern Lights for sleep"), "T02-a: real title accepted");
assert(looksLikeTitle("Do Si Dos potency talk"), "T02-b: strain-led title accepted");
assert(looksLikeTitle("Growing setup basics"), "T02-c: short title accepted");

// ── T03: the blank-reply costume line never reaches the title model ──
const transcript = buildTitleTranscript([
  { role: "user", content: "what helps with sleep?" },
  { role: "assistant", content: BLANK_REPLY_FALLBACK },
  { role: "user", content: "northern lights maybe?" },
]);
assert(
  !transcript.includes(BLANK_REPLY_FALLBACK),
  "T03: blank-reply fallback must be filtered out of the title transcript"
);
assert(
  transcript.includes("northern lights"),
  "T03-b: real conversation content must remain in the transcript"
);

// ── L01: ILIKE wildcards are escaped; plain names pass through unchanged ──
assert.strictEqual(
  escapeLikePattern("100% OG"),
  "100\\% OG",
  "L01-a: % must be escaped for ILIKE"
);
assert.strictEqual(
  escapeLikePattern("Northern Lights"),
  "Northern Lights",
  "L01-b: plain names pass through unchanged"
);

// ── L02: type resolution for the /memory badge ──
// A known dataset strain resolves to a real type (de-hyphenated form, the
// shape stored by addLikedStrain); an unknown literal stays null.
const nlType = lookupStrainType("northern lights");
assert(
  ["indica", "sativa", "hybrid"].includes(nlType),
  `L02-a: 'northern lights' must resolve to a valid type, got ${JSON.stringify(nlType)}`
);
assert.strictEqual(
  lookupStrainType("razzle's dazzle"),
  null,
  "L02-b: unknown literal names stay type-null"
);
// Spelling variant: type attaches via the high-confidence closest match,
// while the stored name stays exactly what the user said.
assert.strictEqual(
  lookupStrainType("grandaddy purp"),
  "indica",
  "L02-c: 'grandaddy purp' must borrow Granddaddy-Purple's indica type"
);
assert.strictEqual(
  lookupStrainType("cereal milk"),
  null,
  "L02-d: names absent from the dataset stay type-null"
);

console.log("save-intent-check: all assertions passed");
