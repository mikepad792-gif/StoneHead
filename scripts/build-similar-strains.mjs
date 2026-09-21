// scripts/build-similar-strains.mjs
//
// Precomputes data/similar-strains.json: for every strain with a full record,
// the top N most profile-similar other strains.
//
// Run offline, commit the output. The reaction handler is then a lookup, not a
// search, and the model NEVER chooses which strain to recommend - it is handed
// one. That is the point: a model asked for "a similar strain" will invent one
// that isn't in the database.
//
//   node scripts/build-similar-strains.mjs
//
// Re-run whenever data/strains.json changes.

import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("data/strains.json");
const OUT = path.resolve("data/similar-strains.json");

const TOP_N = 5;          // candidates kept per strain; handler picks among them
const MIN_SCORE = 0.35;   // below this it isn't a recommendation, it's noise

// Weights. Effects matter most (it's what people are asking for), flavor next,
// type is a small nudge rather than a gate so an indica can suggest a hybrid
// with the same profile.
const W_EFFECTS = 0.45;
const W_FLAVOR = 0.40;
const W_TYPE = 0.15;

const set = (v) =>
  new Set(
    String(v ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && x !== "None")
  );

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// Tokens of a strain name, for the "don't recommend the same family" guard.
const nameTokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );

const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));

// Only strains with something worth reading. A name-only record has no
// profile to score and nothing to show if someone taps through.
const pool = raw.filter(
  (r) =>
    (r.data_depth ? r.data_depth === "full" : true) &&
    String(r.Description ?? "").trim().length > 40 &&
    set(r.Effects).size > 0 &&
    set(r.Flavor).size > 0
);

console.log(`pool: ${pool.length} of ${raw.length} records`);

const pre = pool.map((r) => ({
  name: String(r.Strain),
  type: String(r.Type ?? "").trim().toLowerCase(),
  effects: set(r.Effects),
  flavor: set(r.Flavor),
  tokens: nameTokens(r.Strain),
}));

const out = {};
let noCandidates = 0;

for (let i = 0; i < pre.length; i++) {
  const a = pre[i];
  const scored = [];

  for (let j = 0; j < pre.length; j++) {
    if (i === j) continue;
    const b = pre[j];

    // Same-family guard. "Blue Dream" recommending "Dark Blue Dream" is not a
    // recommendation, it's a restatement. Any shared significant token kills it.
    let shares = false;
    for (const t of a.tokens) if (b.tokens.has(t)) { shares = true; break; }
    if (shares) continue;

    const score =
      W_EFFECTS * jaccard(a.effects, b.effects) +
      W_FLAVOR * jaccard(a.flavor, b.flavor) +
      (a.type && a.type === b.type ? W_TYPE : 0);

    if (score >= MIN_SCORE) scored.push({ name: b.name, score, b });
  }

  scored.sort((x, y) => y.score - x.score);
  const top = scored.slice(0, TOP_N);
  if (!top.length) { noCandidates++; continue; }

  out[a.name] = top.map(({ name, score, b }) => {
    const sharedEffects = [...a.effects].filter((x) => b.effects.has(x));
    const sharedFlavor = [...a.flavor].filter((x) => b.flavor.has(x));
    return {
      strain: name,
      score: Number(score.toFixed(3)),
      // These two lists are what the prompt is allowed to build a "both" or
      // "same" sentence around. Anything outside them is an invented claim.
      shared_effects: sharedEffects,
      shared_flavor: sharedFlavor,
      same_type: a.type && a.type === b.type ? a.type : null,
    };
  });
}

fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${Object.keys(out).length} entries to ${OUT}`);
console.log(`strains with no candidate above ${MIN_SCORE}: ${noCandidates}`);
