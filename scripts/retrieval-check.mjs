// scripts/retrieval-check.mjs
// Retrieval regression harness — run: node scripts/retrieval-check.mjs
//
// Asserts on the three canonical messages from the live diagnosis.
// DO NOT alter the message text — it is the exact text that was diagnosed.
//
import assert from "node:assert";

const { searchStrains, parseConstraints, suggestStrainCorrection } = await import("../lib/strainSearch.js");

const MSG = {
  cali: `I tried a strain labeled Cali Mist and the high was perfect. Since then I've tried Jack Herer, Key Lime Jack, Super Silver Haze but nothing matched. The high started off strong, super adventurous and visually intense — my surroundings looked different in size and perspective, like a mild psychedelic effect, very mentally engaging. The comedown was smooth, chilled out and relaxed, but importantly not sleepy, which is something I absolutely avoid. anything mostly into indica side is a no go for me. I don't smoke for medical use — just chasing that perfect creative uplifting high. I avoid anything heavy on the indica side.`,
  motivation: `I have tried many strains but can't find one that wakes you up and gets you motivated, not put you to sleep. Best I've found is Super Lemon Haze. I was thinking some green crack or blue dream. Correct me if I am wrong but this would be a heavy sativa with low THC and CBD with high CBN.`,
  creativity: `I'm a 3d artist and game dev using unreal 4. Just wondering what strains you guys think would make me more creative and productive? There has got to be some strains that make you focused, lower anxiety, and promote creative thought more than others, no?`,
};

function names(rows) { return rows.map((r) => r.strain_name); }
function types(rows) { return rows.map((r) => r.strain_type); }

// ── C01: constraint parsing ──
const c = parseConstraints(MSG.cali);
assert(c.excludedTypes.has("indica"), "C01-parse: 'indica' must be an excluded type");
assert(!c.excludedTypes.has("sativa"), "C01-parse: 'sativa' must NOT be excluded");

// ── C01-a (P0): no indica may be recommended ──
const r1 = searchStrains(MSG.cali);
assert(!types(r1).includes("indica"), `C01-a: results must contain ZERO indicas, got ${JSON.stringify(names(r1))}/${JSON.stringify(types(r1))}`);

// ── C01-b (P1 STRETCH, non-fatal): Kali Mist in the top-3 cards ──
// Per spec §7: the user's explicitly-named strains (Jack Herer / Super Silver
// Haze) and literal effect-tag overlap can still outrank Kali Mist, which only
// shares one tag ("creative") with a richly-DESCRIBED experience. Ranking it
// above those is the P2 (semantic) boundary — do not force a brittle hack.
if (!names(r1).some((n) => /kali-mist/i.test(n))) {
  console.warn(`C01-b (stretch, expected miss until P2): Kali Mist not in top-3 cards; got ${JSON.stringify(names(r1))}`);
}

// ── C01-c (P1, REQUIRED): the achievable win — surface the spelling fix ──
// Even when ranking can't lift Kali Mist into the cards, the closest-match
// resolver must tell the model "Cali Mist → Kali Mist" (the move that won the
// real thread). This is read-only and ranking-independent.
const corr = suggestStrainCorrection(MSG.cali);
assert(corr && /kali-mist/i.test(corr.suggestion), `C01-c: closest-match should suggest Kali Mist for "Cali Mist", got ${JSON.stringify(corr)}`);

// ── C02 (no regression): a strong energizing sativa still surfaces ──
const r2 = searchStrains(MSG.motivation);
assert(names(r2).some((n) => /super-green-crack|green-crack|green-haze/i.test(n)), `C02: expected a green/energizing sativa, got ${JSON.stringify(names(r2))}`);

// ── C03 (no regression): creativity match still surfaces ──
const r3 = searchStrains(MSG.creativity);
assert(r3.length > 0, "C03: expected at least one creativity match");

console.log("All retrieval checks passed.");
