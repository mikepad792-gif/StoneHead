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

const { detectFrame, classifyTopic, hasDiagnosisCue } = await import("../lib/frameDetect.js");

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

console.log("frame-check: all assertions passed");
