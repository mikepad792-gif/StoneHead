// scripts/age-check.mjs
// Age self-identification regression harness (Addendum A2).
// Run: node scripts/age-check.mjs
//
// Covers runbook tests A6 (persistence), A7 (false positives) and the
// detection half of A8 (plant-tab revocation). A8's endpoint behavior is an
// integration test against a live database and belongs in the runbook, not
// here — what this file proves is that the band that drives it is correct.
//
// SAME RULE AS crisis-check.mjs: no test string may be a phrase the detector
// literally contains. These are all ordinary sentences.

import assert from "node:assert";

const {
  detectAge,
  bandForAge,
  blocksCannabis,
  belowFloor,
  UNDER_13_REPLY,
} = await import("../lib/ageDetect.js");

let checks = 0;
function check(fn) { checks++; fn(); }

// ═══════════════════════════════════════════════════════════════════
// A — the statements that must fire, and the band each lands in.
// ═══════════════════════════════════════════════════════════════════

const FIRES = [
  ["im 14 and ive been really stressed in school", "minor"],
  ["i am 15 btw", "minor"],
  ["i just turned 16 last week", "minor"],
  ["im about to be 17", "minor"],
  ["im fourteen", "minor"],
  ["15 years old and bored out of my mind", "minor"],
  ["im 19 and my roommate is driving me nuts", "under_21"],
  ["im twenty", "under_21"],
  ["im 12", "under_13"],
  ["im eleven", "under_13"],
  ["im in 9th grade", "minor"],
  ["im a freshman this year", "minor"],
  ["im in middle school", "minor"],
];

for (const [msg, band] of FIRES) {
  check(() => assert.strictEqual(
    detectAge(msg).band, band,
    `A: "${msg}" should land in band "${band}", got "${detectAge(msg).band}"`
  ));
}

// ═══════════════════════════════════════════════════════════════════
// B — A7: false positives. None of these may set the flag.
// ═══════════════════════════════════════════════════════════════════
// The first two are the addendum's named cases. The rest are the same shapes
// a real plant-tab or parent conversation produces.

const MUST_NOT_FIRE = [
  "im 14 hours into this grow and the leaves look weird",
  "my kid is 14 and getting into some stuff, worried about him",
  "when i was 14 i thought that too",
  "im 34",
  "im 45 and just getting back into growing",
  "my nephew is 16 and asks me about this stuff",
  "i was 17 when i first tried it",
  "im 20 minutes from the dispensary",
  "she is 15 and it worries me",
  "my daughter is in high school",
  "i teach high school",
  "back in high school i was a mess",
  "im 3 weeks into flower",
  "got 12 plants going",
];

for (const msg of MUST_NOT_FIRE) {
  check(() => assert.strictEqual(
    detectAge(msg).band, null,
    `B: "${msg}" must NOT set a band, got "${detectAge(msg).band}"`
  ));
}

// ═══════════════════════════════════════════════════════════════════
// C — A6: persistence. The failure this whole item exists for.
// ═══════════════════════════════════════════════════════════════════
// The detector is stateless by design; persistence is the caller storing the
// band on the USER record. This models that contract exactly as chat-send.js
// implements it, including the fourth turn in a FRESH THREAD — which is the
// part that catches a thread-scoped implementation.

function simulateAccount(turnsByThread) {
  // Mirrors chat-send.js: read the stored band, only detect when it's unset,
  // and never clear it.
  let stored = null;
  const seen = [];
  for (const thread of turnsByThread) {
    for (const msg of thread) {
      if (!stored) {
        const hit = detectAge(msg);
        if (hit.band) stored = hit.band;
      }
      seen.push({ msg, bandInEffect: stored });
    }
  }
  return seen;
}

{
  const trace = simulateAccount([
    [
      "im 14 and ive been really stressed in school",
      "my friends smoke do you think i should try it",
      "whats it actually like though",
    ],
    // New thread, same account — this is the turn that catches thread-scoped
    // state. It contains no age statement of its own.
    ["what does being high feel like"],
  ]);

  check(() => assert.strictEqual(
    trace[0].bandInEffect, "minor",
    "C-A6: turn 1 must set the band"
  ));
  for (const i of [1, 2, 3]) {
    check(() => assert.strictEqual(
      trace[i].bandInEffect, "minor",
      `C-A6: turn ${i + 1} ("${trace[i].msg}") must still be flagged — ` +
      `this is the turn that failed twice, and turn 4 is in a NEW THREAD`
    ));
  }
  check(() => assert.ok(
    blocksCannabis(trace[3].bandInEffect),
    "C-A6: the fresh-thread turn must still block experiential content"
  ));
}

// C2: a retraction does not clear the flag.
{
  const trace = simulateAccount([["im 15", "actually im 25 i was messing with you"]]);
  check(() => assert.strictEqual(
    trace[1].bandInEffect, "minor",
    "C2: a later retraction must not clear the band — otherwise it's trivially bypassable"
  ));
}

// C3: a 21+ statement stores nothing. There is no behavior to constrain.
check(() => assert.strictEqual(
  detectAge("im 25").band, null,
  "C3: an adult age must not set a band"
));

// ═══════════════════════════════════════════════════════════════════
// D — band semantics.
// ═══════════════════════════════════════════════════════════════════

check(() => assert.strictEqual(bandForAge(12), "under_13", "D: 12 is under_13"));
check(() => assert.strictEqual(bandForAge(13), "minor", "D: 13 is the floor, still a minor"));
check(() => assert.strictEqual(bandForAge(17), "minor", "D: 17 is a minor"));
check(() => assert.strictEqual(bandForAge(18), "under_21", "D: 18 is an adult, not for cannabis"));
check(() => assert.strictEqual(bandForAge(20), "under_21", "D: 20 is still under_21"));
check(() => assert.strictEqual(bandForAge(21), null, "D: 21 needs no band"));

// A8's precondition: every band that exists blocks the plant tab.
for (const band of ["under_13", "minor", "under_21"]) {
  check(() => assert.ok(
    blocksCannabis(band),
    `D-A8: band "${band}" must close the plant tab regardless of prior 21+ confirmation`
  ));
}
check(() => assert.strictEqual(blocksCannabis(null), false, "D: no band, no block"));
check(() => assert.ok(belowFloor("under_13"), "D: under_13 is below the ToS floor"));
check(() => assert.strictEqual(belowFloor("minor"), false, "D: a 15-year-old is above the floor"));

// ═══════════════════════════════════════════════════════════════════
// E — contract guards.
// ═══════════════════════════════════════════════════════════════════

for (const junk of [undefined, null, "", "   ", 12345, {}, []]) {
  check(() => assert.strictEqual(
    detectAge(junk).band, null,
    `E: junk input must not set a band — ${JSON.stringify(junk)}`
  ));
}

// E2: the under-13 reply is fixed text that stops, kindly, with no stage
// directions and no lecture.
check(() => assert.ok(
  UNDER_13_REPLY.length > 0 && !/\*[^*]+\*/.test(UNDER_13_REPLY),
  "E2: the under-13 reply must exist and carry no stage directions"
));

// E3: the band is all that's stored for a minor. The detector may report the
// number it saw for logging, but bandForAge is what the caller persists —
// asserted here so a future change that starts storing ages is a test failure
// rather than a quiet privacy regression.
check(() => assert.strictEqual(
  detectAge("im 14").stated, 14,
  "E3: the detector reports what it saw..."
));
check(() => assert.strictEqual(
  detectAge("im in 9th grade").stated, null,
  "E3: ...but a grade-level signal yields no number at all, which is the point"
));

console.log(
  `age-check: OK — ${checks} assertions. ` +
  `${FIRES.length} firing statements, ${MUST_NOT_FIRE.length} false-positive guards, ` +
  `A6 persistence across a fresh thread, A7, and A8's band precondition`
);
