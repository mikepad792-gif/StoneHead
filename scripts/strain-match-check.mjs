// scripts/strain-match-check.mjs
// Compound-word matching regression harness.
//
// Convention matches scripts/frame-check.mjs: node:assert, dynamic import,
// numbered case IDs in failure messages.
//
// STRAIN NAMES ARE VERIFIED AGAINST data/strains.json. The dataset stores
// names slug-style ("Blue-Dream", "Og-Kush", "Longbottom-Leaf"), so the
// spaced spellings in the original spec were corrected to the exact dataset
// strings before this file was trusted — a name that isn't in the file makes
// a green test meaningless. Block E below re-checks that on every run, so
// this can't silently rot if the dataset changes.

import assert from "node:assert";

const { containsWholeWord } = await import("../lib/strainSearch.js");
const { loadDataFile } = await import("../lib/dataFile.js");

// ── A: the actual bug. Real names from strains.json. ──
// Each pair is (what the user typed, what the data holds).
const SPLIT_JOIN = [
  ["A01", "have you heard of long bottom leaf", "Longbottom-Leaf"],
  ["A02", "have you heard of longbottom leaf",  "Longbottom-Leaf"],
  ["A03", "what about chemssister",             "Chems-Sister"],
  ["A04", "what about chems sister",            "Chems-Sister"],
  ["A05", "tell me about white kush",           "White-Kush"],
  ["A06", "tell me about whitekush",            "White-Kush"],
  ["A07", "is thaihaze any good",               "Thai-Haze"],
  ["A08", "is thai haze any good",              "Thai-Haze"],
];

for (const [id, message, name] of SPLIT_JOIN) {
  assert.ok(
    containsWholeWord(message, name),
    `${id}: "${message}" should match strain "${name}"`
  );
}

// ── B: everything the token pass already got right must STILL pass. ──
// If the joined pass ever replaces rather than supplements the token
// pass, these are what catch it.
const STILL_MATCHES = [
  ["B01", "i love blue dream",              "Blue-Dream"],
  ["B02", "got any northern lights",        "Northern-Lights"],
  ["B03", "sour diesel is my favorite",     "Sour-Diesel"],
  ["B04", "how about og kush",              "Og-Kush"],
];

for (const [id, message, name] of STILL_MATCHES) {
  assert.ok(
    containsWholeWord(message, name),
    `${id}: existing match regressed — "${message}" / "${name}"`
  );
}

// ── C: false positives. Test this hardest. ──
// The joined pass is the risky half; without boundary anchoring it
// reintroduces exactly the substring bug the whole-word rule prevents.
const MUST_NOT_MATCH = [
  ["C01", "that was a good idea",                    "Goo"],
  ["C02", "i work in biochemssisterhood research",   "Chems-Sister"],
  ["C03", "the whitewashing of cannabis history",    "White-Kush"],
  ["C04", "bluedreaming about vacation",             "Blue-Dream"],
  ["C05", "my longbottomless coffee",                "Longbottom-Leaf"],
  ["C06", "haze of confusion",                       "Thai-Haze"],
];

for (const [id, message, name] of MUST_NOT_MATCH) {
  assert.ok(
    !containsWholeWord(message, name),
    `${id}: FALSE POSITIVE — "${message}" must not match "${name}"`
  );
}

// ── D: contract guards. ──
for (const junk of [undefined, null, "", "   ", 12345, {}, []]) {
  assert.strictEqual(
    containsWholeWord(junk, "Blue-Dream"), false,
    `D01: junk haystack must not match — ${JSON.stringify(junk)}`
  );
  assert.strictEqual(
    containsWholeWord("i love blue dream", junk), false,
    `D02: junk needle must not match — ${JSON.stringify(junk)}`
  );
}

// D03: the joined pass declines short needles rather than guessing.
assert.strictEqual(
  containsWholeWord("that was a good idea", "Goo"), false,
  "D03: short joined needles must not fire"
);

// ── E: every name used above really is in the dataset, spelled exactly. ──
// Without this, a typo in a name turns a false-positive case green for the
// wrong reason and a split/join case red for the wrong reason.
const DATASET_NAMES = new Set(
  loadDataFile("strains.json").map((s) => String(s.Strain || "").trim())
);
const USED = new Set(
  [...SPLIT_JOIN, ...STILL_MATCHES, ...MUST_NOT_MATCH].map(([, , name]) => name)
);
for (const name of USED) {
  assert.ok(
    DATASET_NAMES.has(name),
    `E01: "${name}" is not in data/strains.json — a name that isn't in the file makes this harness meaningless`
  );
}

console.log(
  `strain-match-check: OK — ${SPLIT_JOIN.length} split/join cases, ` +
  `${STILL_MATCHES.length} regression cases, ${MUST_NOT_MATCH.length} false-positive cases, ` +
  `${USED.size} names confirmed present in strains.json`
);
