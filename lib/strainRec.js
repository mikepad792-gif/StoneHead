// lib/strainRec.js
// /rec in the Discord bot (v2.2.1): "something chill for a movie night",
// "fruity, not too sleepy". The PICK is made here, from strains.json, by
// effects, flavors and type, one strain per card (🔄 asks for another). The
// model only writes about the strain it is handed; it never chooses one. A model asked to "recommend something"
// names strains that were never in the database, which is the failure this
// file exists to make impossible.
//
// Read the ask into wants and avoids (clause-scoped negation, like
// parseConstraints), filter out anything that hits an avoid, score the rest by
// how many of the asks they cover, and hand back up to three, shuffled; the
// endpoint shows the first. "Nothing fits"
// and "too vague to pick" are real answers, decided here, before any model
// call or rate-limit spend.

import { loadDataFile } from "./dataFile.js";

export const MAX_PICKS = 3;

// ── Vocabulary ──────────────────────────────────────────────────────
// Word or phrase -> the database's own effect names. Phrases are matched
// before single words, on whole words only.
const EFFECT_WORDS = [
  [["chill", "chilled", "relax", "relaxed", "relaxing", "mellow", "calm", "calming", "unwind", "wind down",
    "couch", "couchlock", "couch lock", "lazy", "laid back", "lay back", "movie", "movies", "netflix",
    "stress", "stressed", "body high", "melt"], "Relaxed"],
  [["sleep", "sleepy", "sleeping", "bed", "bedtime", "knock me out", "knocks me out", "knock out",
    "knocked out", "put me to sleep", "puts me to sleep", "nighttime", "night time", "drowsy", "nap"], "Sleepy"],
  [["happy", "happiness", "good mood", "cheerful", "good vibes", "vibes"], "Happy"],
  [["euphoric", "euphoria", "buzz", "buzzy", "heady", "head high", "blissful"], "Euphoric"],
  [["uplift", "uplifted", "uplifting", "upbeat", "lift me up", "pick me up", "positive"], "Uplifted"],
  [["creative", "creativity", "create", "art", "artsy", "draw", "drawing", "paint", "painting", "music",
    "write", "writing", "inspired", "ideas", "brainstorm"], "Creative"],
  [["energy", "energetic", "energized", "wake", "wake and bake", "awake", "active", "workout", "hike",
    "hiking", "daytime", "day time", "morning", "productive", "get stuff done", "chores", "cleaning"], "Energetic"],
  [["focus", "focused", "concentrate", "concentration", "study", "studying", "work", "working", "clear headed",
    "clearheaded", "sharp"], "Focused"],
  [["hungry", "munchies", "munchy", "appetite", "eat", "eating", "snack", "snacks"], "Hungry"],
  [["talkative", "chatty", "social", "talk", "talking", "conversation", "friends", "party", "hang", "hangout",
    "hanging out"], "Talkative"],
  [["giggly", "giggle", "giggles", "laugh", "laughing", "funny", "silly", "goofy", "comedy"], "Giggly"],
  [["tingly", "tingle", "tingles"], "Tingly"],
  [["aroused", "arousal", "date night", "romantic", "romance", "intimate", "sexy"], "Aroused"],
];

// Flavor groups: one ask ("fruity") is met by any flavor in its group.
const FLAVOR_GROUPS = [
  [["fruity", "fruit", "fruits", "juicy"], "fruity",
    ["Berry", "Blueberry", "Strawberry", "Grape", "Tropical", "Mango", "Pineapple", "Apple", "Peach", "Pear",
      "Plum", "Apricot", "Fruit", "Citrus", "Lemon", "Lime", "Orange", "Grapefruit"]],
  [["citrus", "citrusy", "zesty", "lemon", "lemony", "lime", "orange", "grapefruit"], "citrus",
    ["Citrus", "Lemon", "Lime", "Orange", "Grapefruit"]],
  [["berry", "berries", "blueberry", "strawberry"], "berry", ["Berry", "Blueberry", "Strawberry"]],
  [["grape", "grapey"], "grape", ["Grape"]],
  [["tropical", "mango", "pineapple"], "tropical", ["Tropical", "Mango", "Pineapple"]],
  [["sweet", "candy", "sugary", "dessert", "vanilla", "honey"], "sweet", ["Sweet", "Vanilla", "Honey"]],
  [["earthy", "earth", "dirt", "dirty"], "earthy", ["Earthy"]],
  [["pine", "piney", "woody", "wood", "forest"], "piney", ["Pine", "Woody", "Tree"]],
  [["gas", "gassy", "diesel", "fuel", "chemical", "chem"], "gassy", ["Diesel", "Chemical", "Ammonia"]],
  [["skunk", "skunky", "dank", "funky", "funk", "pungent", "loud"], "skunky", ["Skunk", "Pungent"]],
  [["cheese", "cheesy"], "cheesy", ["Cheese"]],
  [["mint", "minty", "menthol"], "minty", ["Mint", "Minty", "Menthol"]],
  [["spicy", "spice", "herbal", "pepper", "peppery", "sage"], "spicy", ["Spicy/Herbal", "Pepper", "Sage"]],
  [["floral", "flowery", "flower", "lavender", "rose", "violet"], "floral", ["Flowery", "Lavender", "Rose", "Violet"]],
  [["coffee", "nutty", "nut", "chestnut", "tea", "butter", "buttery"], "nutty", ["Coffee", "Nutty", "Chestnut", "Tea", "Butter"]],
];

const TYPE_WORDS = { indica: "indica", sativa: "sativa", hybrid: "hybrid" };

// Health asks. Never answered as treatment; mapped only to the effects people
// commonly report, and flagged so the prompt says so plainly.
const MEDICAL_WORDS = [
  [["anxiety", "anxious", "panic", "panic attacks", "ptsd", "trauma"], "Relaxed"],
  [["pain", "chronic pain", "aches", "ache", "arthritis", "migraine", "migraines", "headache", "headaches",
    "cramps", "back pain", "inflammation", "fibromyalgia", "sore"], "Relaxed"],
  [["insomnia", "cant sleep", "can't sleep", "trouble sleeping"], "Sleepy"],
  [["depression", "depressed"], "Uplifted"],
  [["nausea", "nauseous", "chemo", "no appetite", "loss of appetite"], "Hungry"],
  [["adhd", "seizure", "seizures", "epilepsy", "cancer", "glaucoma", "crohns", "ms", "multiple sclerosis",
    "medical", "medicine", "medicinal", "treat my", "treatment", "cure", "condition", "symptoms", "prescription"], null],
];

const SOURCING_WORDS = [
  "buy", "buying", "purchase", "cop", "plug", "dealer", "dispensary", "dispensaries", "order online", "where to order", "delivery",
  "deliver", "ship", "shipping", "price", "prices", "cost", "cheap", "sell", "sells", "selling", "seeds",
  "where can i get", "where to get", "where do i get", "where can i find", "near me", "in stock",
];

const NEGATION = new Set([
  "no", "not", "non", "none", "without", "avoid", "avoiding", "never", "skip", "except", "hate", "hates",
  "dislike", "nothing", "dont", "doesnt", "isnt", "arent", "aint", "wont", "cant", "shouldnt", "less",
]);

function norm(text) {
  return " " + String(text || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9/]+/g, " ").trim() + " ";
}
const has = (hay, word) => hay.includes(" " + word.replace(/['’]/g, "") + " ");

/**
 * Read the ask. Clauses split on punctuation and "and/but", and a clause with
 * a negation cue ("not too sleepy", "nothing gassy", "no indica") turns its
 * terms into avoids.
 *
 * @returns {{ wantEffects: string[], avoidEffects: string[], wantFlavors: object[],
 *   avoidFlavors: object[], wantTypes: string[], avoidTypes: string[],
 *   medical: string[], sourcing: boolean, understood: boolean }}
 */
export function analyzeAsk(text) {
  const out = {
    wantEffects: new Set(), avoidEffects: new Set(), wantFlavors: new Map(), avoidFlavors: new Map(),
    wantTypes: new Set(), avoidTypes: new Set(), medical: new Set(), sourcing: false,
  };
  const whole = norm(text);
  out.sourcing = SOURCING_WORDS.some((w) => has(whole, w));

  const clauses = String(text || "").toLowerCase().replace(/['’]/g, "")
    .split(/[.,;:!?\n]+|—|–|\s-\s|\b(?:and|but|or|plus|also|though|just)\b/);
  for (const raw of clauses) {
    const c = norm(raw);
    if (!c.trim()) continue;
    const negated = c.trim().split(" ").some((t) => NEGATION.has(t)) && !/\bnot too bad\b/.test(c);

    for (const [words, effect] of EFFECT_WORDS) {
      if (words.some((w) => has(c, w))) (negated ? out.avoidEffects : out.wantEffects).add(effect);
    }
    for (const [words, label, flavors] of FLAVOR_GROUPS) {
      if (words.some((w) => has(c, w))) (negated ? out.avoidFlavors : out.wantFlavors).set(label, flavors);
    }
    for (const [word, type] of Object.entries(TYPE_WORDS)) {
      if (has(c, word)) (negated ? out.avoidTypes : out.wantTypes).add(type);
    }
    for (const [words, effect] of MEDICAL_WORDS) {
      const hit = words.find((w) => has(c, w));
      if (!hit) continue;
      out.medical.add(hit);
      if (effect && !negated) out.wantEffects.add(effect);
    }
  }
  // A thing can't be both wanted and avoided; the avoid wins.
  for (const e of out.avoidEffects) out.wantEffects.delete(e);
  for (const f of out.avoidFlavors.keys()) out.wantFlavors.delete(f);
  for (const t of out.avoidTypes) out.wantTypes.delete(t);

  const result = {
    wantEffects: [...out.wantEffects], avoidEffects: [...out.avoidEffects],
    wantFlavors: [...out.wantFlavors].map(([label, flavors]) => ({ label, flavors })),
    avoidFlavors: [...out.avoidFlavors].map(([label, flavors]) => ({ label, flavors })),
    wantTypes: [...out.wantTypes], avoidTypes: [...out.avoidTypes],
    medical: [...out.medical], sourcing: out.sourcing,
  };
  result.understood = result.wantEffects.length + result.wantFlavors.length + result.wantTypes.length > 0;
  return result;
}

const splitList = (v) => (!v || v === "None" ? [] : String(v).split(",").map((s) => s.trim()).filter(Boolean));

let pool = null;
function strainPool() {
  if (!pool) {
    pool = loadDataFile("strains.json")
      .map((s) => ({
        strain: String(s.Strain || "").trim(),
        type: String(s.Type || "").toLowerCase(),
        rating: Number(s.Rating) || 0,
        effects: splitList(s.Effects),
        flavors: splitList(s.Flavor),
      }))
      .filter((s) => s.strain && s.effects.length && s.flavors.length);
  }
  return pool;
}

/**
 * Pick up to three strains for an analyzed ask.
 *
 * Hard filters: any avoided effect, flavor group or type. Then each wanted
 * effect, flavor group and type is one "ask"; a strain's coverage is the share
 * of asks it meets. Best coverage first, then rating, then a shuffle among
 * equals so the same ask doesn't always get the same three.
 *
 * @param {object} ask - from analyzeAsk
 * @param {{ rng?: () => number, exclude?: (name: string) => boolean }} [opts]
 * @returns {{ fit: "good"|"partial"|"none", picks: Array<{ strain, type, effects,
 *   flavors, matched: string[], missing: string[], coverage: number }> }}
 */
export function recommendStrains(ask, { rng = Math.random, exclude = () => false } = {}) {
  // The source lists effects and flavors strongest first, so a wanted effect
  // near the front counts for more than one in fifth place.
  const asks = [
    ...ask.wantEffects.map((e) => ({
      label: e.toLowerCase(),
      test: (s) => s.effects.includes(e),
      strength: (s) => Math.max(0, 6 - s.effects.indexOf(e)),
    })),
    ...ask.wantFlavors.map((g) => ({
      label: g.label,
      test: (s) => s.flavors.some((f) => g.flavors.includes(f)),
      strength: (s) => s.flavors.filter((f) => g.flavors.includes(f)).length * 2
        + Math.max(0, 3 - s.flavors.findIndex((f) => g.flavors.includes(f))),
    })),
    ...ask.wantTypes.map((t) => ({ label: t, test: (s) => s.type === t, strength: () => 0 })),
  ];
  if (!asks.length) return { fit: "none", picks: [] };

  const scored = [];
  for (const s of strainPool()) {
    if (exclude(s.strain)) continue;
    if (ask.avoidEffects.some((e) => s.effects.includes(e))) continue;
    if (ask.avoidFlavors.some((g) => s.flavors.some((f) => g.flavors.includes(f)))) continue;
    if (ask.avoidTypes.includes(s.type)) continue;
    const matched = [], missing = [];
    let strength = 0;
    for (const a of asks) {
      if (a.test(s)) { matched.push(a.label); strength += a.strength(s); } else missing.push(a.label);
    }
    if (!matched.length) continue;
    scored.push({ ...s, matched, missing, coverage: matched.length / asks.length, strength, jitter: rng() });
  }
  if (!scored.length) return { fit: "none", picks: [] };

  scored.sort((a, b) =>
    b.coverage - a.coverage
    || (b.rating >= 4) - (a.rating >= 4)
    || b.strength - a.strength);
  const best = scored[0].coverage;
  // Under half of what they asked for isn't a recommendation, it's a guess.
  if (best < 0.5) return { fit: "none", picks: [] };

  // Three at random from the strongest dozen of the best tier, so the same
  // ask doesn't hand back the same three every time.
  const shortlist = scored.filter((s) => s.coverage === best).slice(0, 12)
    .sort((a, b) => a.jitter - b.jitter);
  const picks = shortlist.slice(0, MAX_PICKS);
  // Topping up with a weaker tier only when the best tier is thin, and only
  // with picks that still cover at least half.
  for (const s of scored) {
    if (picks.length >= MAX_PICKS) break;
    if (s.coverage < best && s.coverage >= 0.5) picks.push(s);
  }
  const clean = picks.map(({ jitter, rating, strength, ...p }) => p);
  return { fit: best === 1 ? "good" : "partial", picks: clean };
}
