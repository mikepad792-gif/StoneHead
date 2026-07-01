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
// Note: lib/strainSearch.js reads data via `__dirname` (provided by esbuild in
// the Netlify bundle). Under plain Node ESM that global is absent, so we shim it
// to the lib directory before importing, then dynamic-import the real modules.
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
globalThis.__dirname = path.join(scriptsDir, "..", "lib");

const { detectSaveIntent } = await import("../lib/saveIntent.js");
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

console.log("save-intent-check: all assertions passed");
