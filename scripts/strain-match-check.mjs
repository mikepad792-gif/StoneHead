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

// ═══════════════════════════════════════════════════════════════════
// PART F — ADDENDUM C2. Strain resolution must survive the turn.
// ═══════════════════════════════════════════════════════════════════
//
// The trace, verbatim. Brain-Candy IS in strains.json — Insanity Strains,
// The Loops x White Widow x Northern Lights.
//
//   Turn 1  "Have you heard of brain candy"  -> accurate, grounded answer
//   Turn 2  "What's it lineage"              -> "brain candy's not ringing
//                                               anything in the database"
//   Turn 3  "Yeah it is check again"         -> "I already checked"
//
// It never checked. Retrieval runs per message; turn 2 has no strain name in
// it, so nothing was looked up, and the model reported an empty context block
// as absence from the database. Turn 3 then defended the position.
//
// Same fix shape as the post-crisis window: a pure function over history.

const {
  searchStrains: search,
  lastResolvedStrain,
  lastStrainQuery,
  isStrainFollowUp,
  wantsRecheck,
  formatLookupState,
  asksAboutAStrain,
} = await import("../lib/strainSearch.js");

let fChecks = 0;
function fCheck(fn) { fChecks++; fn(); }

// ── F0: the retrieval bug underneath it. ──
// "have you heard of X" — the single most common shape of strain question in
// the app — was dragging in Haze strains, because `have` is one edit from
// `haze` and both clear the 4-character fuzzy bar. On this very question that
// put two strangers in the context block ahead of the right record.
{
  const hits = search("Have you heard of brain candy").map((s) => s.strain_name);
  fCheck(() => assert.strictEqual(
    hits[0], "Brain-Candy",
    `F0: Brain-Candy must be the top card, got ${JSON.stringify(hits)}`
  ));
  fCheck(() => assert.ok(
    !hits.some((n) => /haze/i.test(n)),
    `F0: "have" must not fuzzy-match "Haze", got ${JSON.stringify(hits)}`
  ));
  // An exact spelling still matches exactly — the guard blocks the fuzzy path
  // only, and blocking real Haze questions would be a worse bug than the one
  // being fixed.
  fCheck(() => assert.ok(
    search("what about purple haze").some((s) => /haze/i.test(s.strain_name)),
    "F0: an exact 'haze' must still retrieve Haze strains"
  ));
}

// ── F1 (A15): the follow-up carries the strain. ──
{
  const history = [
    { role: "user", content: "Have you heard of brain candy" },
    { role: "assistant", content: "yeah man, balanced hybrid, sweet one" },
  ];

  fCheck(() => assert.strictEqual(
    isStrainFollowUp("What's it lineage"), true,
    "F1: 'What's it lineage' is a follow-up"
  ));
  fCheck(() => assert.strictEqual(
    search("What's it lineage").length, 0,
    "F1: ...and on its own it resolves nothing, which is the whole problem"
  ));

  const carry = lastResolvedStrain(history);
  fCheck(() => assert.ok(carry, "F1: the thread's resolved strain must be recoverable"));
  fCheck(() => assert.strictEqual(
    carry.strains[0].strain_name, "Brain-Candy",
    "F1: and it must be Brain-Candy"
  ));
  // The lineage the model claimed did not exist is in the record it had
  // already quoted from.
  fCheck(() => assert.ok(
    /white widow/i.test(carry.strains[0].description),
    "F1: the carried record must contain the lineage that was denied"
  ));
}

// ── F2 (A16): "check again" produces a check. ──
{
  const history = [
    { role: "user", content: "Have you heard of brain candy" },
    { role: "assistant", content: "yeah, that's a real one" },
    { role: "user", content: "What's it lineage" },
    { role: "assistant", content: "I don't actually know that one" },
  ];

  fCheck(() => assert.strictEqual(
    wantsRecheck("Yeah it is check again"), true,
    "F2: 'Yeah it is check again' asks for another look"
  ));
  // The re-check must run against the turn that had the NAME in it. Re-running
  // against "What's it lineage" would search for nothing and call that a
  // second check — which is precisely the lie "I already checked" told.
  fCheck(() => assert.strictEqual(
    lastStrainQuery(history), "Have you heard of brain candy",
    "F2: the re-check targets the turn that named a strain, not the bare follow-up"
  ));
  fCheck(() => assert.strictEqual(
    search(lastStrainQuery(history))[0].strain_name, "Brain-Candy",
    "F2: and re-running it finds the record"
  ));

  // A thread with no strain in it has nothing to re-check, so an ordinary
  // "try again" cannot fire the path.
  fCheck(() => assert.strictEqual(
    lastStrainQuery([
      { role: "user", content: "my landlord still hasn't fixed the sink" },
      { role: "assistant", content: "that's been a while now" },
    ]),
    null,
    "F2: no prior strain query means no re-check target"
  ));
}

// ── F3 (A17): absence of a query is not evidence of absence. ──
// Three states were collapsing into one empty context block. Only `miss`
// licenses a claim that something isn't in the database.
{
  const hit = formatLookupState("hit", { carried: true });
  const miss = formatLookupState("miss");
  const none = formatLookupState("not_attempted");

  fCheck(() => assert.ok(
    /not in the database|isn't in the database|not.*in the database/i.test(none) &&
    /do not say|do NOT say/i.test(none),
    "F3: the not-attempted block must forbid claiming absence"
  ));
  fCheck(() => assert.ok(
    /ask which strain/i.test(none),
    "F3: ...and must say what to do instead"
  ));
  fCheck(() => assert.ok(
    /you do not know this strain/i.test(miss),
    "F3: a real miss may still be reported plainly"
  ));
  // "I already checked" is the turn-3 lie, so the not-attempted block names it
  // as forbidden. Assert it appears there ONLY as a prohibition, and nowhere
  // in the miss block at all.
  fCheck(() => assert.ok(
    /do not say[\s\S]*already checked/i.test(none),
    "F3: the not-attempted block must forbid 'I already checked' by name"
  ));
  fCheck(() => assert.ok(
    !/already checked/i.test(miss),
    "F3: and the miss block must not mention it"
  ));
  fCheck(() => assert.ok(
    /carried forward/i.test(hit) && /do not ask which one/i.test(hit),
    "F3: a carried hit must tell the model not to re-ask for the strain"
  ));
  fCheck(() => assert.ok(
    /looked again/i.test(formatLookupState("miss", { rechecked: true })),
    "F3: a re-checked miss must say it actually looked"
  ));
  fCheck(() => assert.strictEqual(
    formatLookupState("hit"), "",
    "F3: an ordinary fresh hit adds nothing — the record speaks for itself"
  ));
}

// ── F4: the follow-up gate does not fire on ordinary conversation. ──
// A false positive here staples a strain card to small talk, which is the
// failure plant.js spends a paragraph on ("you don't have to talk weed every
// message").
for (const t of [
  "how's it going",
  "hey man what up",
  "thanks bro",
  "i had a rough day at work",
  "it was fine i guess",
  "yeah that one was good",
]) {
  fCheck(() => assert.strictEqual(
    isStrainFollowUp(t), false,
    `F4: "${t}" must not read as a strain follow-up`
  ));
}
for (const t of ["What's it lineage", "whats the flavor", "lineage?", "is it indica or sativa"]) {
  fCheck(() => assert.strictEqual(
    isStrainFollowUp(t), true,
    `F4: "${t}" must read as a strain follow-up`
  ));
}
// asksAboutAStrain moved here from chat-send.js; make sure it still gates.
fCheck(() => assert.strictEqual(asksAboutAStrain("hey what's up"), false, "F4: greeting is not a strain ask"));
fCheck(() => assert.strictEqual(asksAboutAStrain("heard of blue dream?"), true, "F4: 'heard of' is"));

console.log(
  `strain-match-check: OK — ${SPLIT_JOIN.length} split/join cases, ` +
  `${fChecks} Addendum C2 assertions, ` +
  `${STILL_MATCHES.length} regression cases, ${MUST_NOT_MATCH.length} false-positive cases, ` +
  `${USED.size} names confirmed present in strains.json`
);
