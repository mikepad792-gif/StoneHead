// lib/strainSearch.js
// Server-side keyword matching against cannabis_strains_2351.json
// Normalizes capital keys (Strain, Type, etc.) to snake_case on load
// Handles null/empty effects, flavors, descriptions (~4% of records)
//
// DATA FILE: Expects cannabis_strains_2351.json at ../data/strains.json
// relative to this file. During project setup, copy the dev kit's
// cannabis_strains_2351.json to data/strains.json.

import { loadDataFile } from "./dataFile.js";

let strainCache = null;

/**
 * Load and normalize strain data. Cached after first load.
 * Source keys: Strain, Type, Rating, Effects, Flavor, Description
 * Normalized: strain_name, strain_type, rating, effects, flavor, description
 */
function loadStrains() {
  if (strainCache) return strainCache;

  const raw = loadDataFile("strains.json");

  strainCache = raw.map((s) => {
    const strain_name = String(s.Strain || "").trim();
    return {
      strain_name,
      strain_type: (s.Type || "").toLowerCase().trim(),
      rating: s.Rating || 0,
      effects: normalizeList(s.Effects),
      flavor: normalizeList(s.Flavor),
      description: s.Description && s.Description !== "None" ? s.Description.trim() : "",
      // Whole-word tokens of the name, for word-boundary matching (A2):
      // prevents "Goo" from matching inside "good".
      _nameTokens: strain_name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    };
  });

  return strainCache;
}

/** True if `needle` tokens appear as a consecutive run inside `hay` tokens. */
function hasConsecutive(hay, needle) {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Whole-word containment: does `phrase` appear in `text` on word boundaries
 * (not as a substring inside another word)? Shared by strain matching (A2)
 * and the extras lookup (Part B).
 */
export function containsWholeWord(text, phrase) {
  const hay = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const needle = String(phrase || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return hasConsecutive(hay, needle);
}

/**
 * Normalize a comma-separated string to a lowercase array.
 * Handles null, "None", empty strings.
 */
function normalizeList(val) {
  if (!val || val === "None") return [];
  return val
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

// ─── Constraint / negation parsing (P0) ─────────────────────────────
const NEGATION_CUES = new Set([
  "no", "not", "non", "none", "without", "avoid", "avoiding", "avoids", "never",
  "skip", "except", "hate", "hates", "dislike", "dislikes", "nothing", "cant",
  "dont", "doesnt", "isnt", "arent", "aint", // contractions arrive de-punctuated
]);
const TYPE_WORDS = new Set(["indica", "sativa", "hybrid"]);

/**
 * Parse stated exclusions from a message. Clause-scoped so a negation in one
 * clause does not poison positive words in another ("no medical—just creative"
 * must keep "creative" positive).
 * @returns {{ excludedTypes: Set<string>, negatedTerms: Set<string> }}
 */
export function parseConstraints(message) {
  const excludedTypes = new Set();
  const negatedTerms = new Set();

  // Strip apostrophes first so "don't" → "dont" matches the cue set.
  const lower = String(message || "").toLowerCase().replace(/['’]/g, "");

  // Clause boundaries: punctuation incl. em/en dashes + coordinating
  // conjunctions. Em-dash split keeps "creative" out of a "no medical" clause.
  const clauses = lower.split(/[.,;:!?\n]+|—|–|\s-\s|\b(?:and|but|so|because|however|though|just)\b/);

  for (const clause of clauses) {
    const toks = clause.split(/[^a-z0-9]+/).filter(Boolean);
    const hasNeg = toks.some((t) => NEGATION_CUES.has(t)) || /\bno go\b/.test(clause);
    if (!hasNeg) continue;
    for (const t of toks) {
      if (TYPE_WORDS.has(t)) excludedTypes.add(t);
      negatedTerms.add(t); // benign filler is harmless; only type/effect words matter downstream
    }
  }
  return { excludedTypes, negatedTerms };
}

// ─── Fuzzy name matching (P1) ───────────────────────────────────────
/** Levenshtein distance with early exit once the best row min exceeds `max`. */
function lev(a, b, max = Infinity) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[lb];
}

/** A message token "is" a name token if exact, or within edit-distance 1 (len ≥ 4). */
function nameTokenMatch(msgTok, nameTok) {
  if (msgTok === nameTok) return true;
  if (nameTok.length >= 4 && msgTok.length >= 4 && lev(msgTok, nameTok, 1) <= 1) return true;
  return false;
}

/**
 * Does `nameTokens` appear as a consecutive run in `hayTokens`, allowing at
 * most ONE fuzzy substitution? Returns the number of fuzzy subs used (0 =
 * exact), or -1 if no match. ("cali mist" → "kali mist" matches with 1.)
 */
function fuzzyConsecutiveFuzz(hayTokens, nameTokens) {
  const n = nameTokens.length;
  if (n === 0 || n > hayTokens.length) return -1;
  for (let i = 0; i + n <= hayTokens.length; i++) {
    let fuzz = 0, ok = true;
    for (let j = 0; j < n; j++) {
      const mt = hayTokens[i + j], nt = nameTokens[j];
      if (mt === nt) continue;
      if (nt.length >= 4 && mt.length >= 4 && lev(mt, nt, 1) <= 1) {
        fuzz++;
        if (fuzz > 1) { ok = false; break; }
      } else { ok = false; break; }
    }
    if (ok) return fuzz;
  }
  return -1;
}

/** Does an effect/flavor tag match a whole word? Exact, or token member for multi-word tags (P3). */
function tagMatchesWord(tag, word) {
  if (tag === word) return true;
  if (tag.indexOf(" ") !== -1) return tag.split(/\s+/).includes(word);
  return false;
}

/**
 * Search strains by keyword matching. Only returns results when the user's
 * message contains a strain NAME match — casual words like "relaxed" or
 * "happy" that match effects/flavors won't trigger retrieval on their own.
 * This lets the plant tab hold a normal conversation without pulling
 * strain cards on every message.
 *
 * @param {string} userMessage - The user's message text
 * @param {object} [constraints] - pre-parsed { excludedTypes, negatedTerms };
 *                 parsed internally when omitted (keeps existing callers working).
 * @returns {Array} Top matching strains (max 3), empty if no name match
 */
export function searchStrains(userMessage, constraints = null) {
  const { excludedTypes, negatedTerms } = constraints || parseConstraints(userMessage);
  const strains = loadStrains();
  const msgLower = userMessage.toLowerCase().replace(/[^a-z0-9\s\-]/g, "");
  const words = msgLower.split(/\s+/).filter((w) => w.length > 2);
  // All alnum tokens (no length filter) for word-boundary name matching.
  const msgTokens = userMessage.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // Tokens eligible for fuzzy name matching (length ≥ 4, not negated).
  const fuzzTokens = msgTokens.filter((t) => t.length >= 4 && !negatedTerms.has(t));

  if (words.length === 0) return [];

  const scored = strains
    // P0: hard-filter excluded types out of primary results.
    .filter((s) => !excludedTypes.has(s.strain_type))
    .map((strain) => {
      let score = 0;
      let nameHit = false;
      let nameMatch = null; // "exact" | "fuzzy" | "token"

      // Match the strain name on WORD BOUNDARIES, not as a substring (A2),
      // with up to one fuzzy substitution (P1): "cali mist" → "kali mist".
      const nameTokens = strain._nameTokens;
      const fz = nameTokens.length > 0 ? fuzzyConsecutiveFuzz(msgTokens, nameTokens) : -1;
      if (fz >= 0) {
        score += 5;
        nameHit = true;
        nameMatch = fz > 0 ? "fuzzy" : "exact";
      } else {
        // Fall back to whole-token name matching, fuzzy-tolerant, skipping
        // negated terms so "no indica" can't create a name hit.
        for (const nt of nameTokens) {
          if (nt.length <= 3) continue;
          for (const mt of fuzzTokens) {
            if (nameTokenMatch(mt, nt)) {
              score += 3;
              nameHit = true;
              nameMatch = nameMatch || "token";
              break;
            }
          }
        }
      }

      // Only score effects/flavors/type if there's already a name hit.
      // P0: skip negated terms. P3: word-boundary (exact token) matching.
      if (nameHit) {
        for (const word of words) {
          if (negatedTerms.has(word)) continue;
          for (const effect of strain.effects) if (tagMatchesWord(effect, word)) score += 2;
          for (const flav of strain.flavor) if (tagMatchesWord(flav, word)) score += 2;
          if (strain.strain_type === word) score += 2;
        }
      }

      return { ...strain, score, nameHit, nameMatch };
    })
    .filter((s) => s.nameHit && s.score >= 3)
    .sort((a, b) => b.score - a.score || b.rating - a.rating)
    .slice(0, 3);

  return scored;
}

/**
 * Format matched strains into the [STRAIN CONTEXT] block for injection
 * into the user message before sending to the AI.
 *
 * @param {Array} strains - Matched strain objects from searchStrains()
 * @returns {string} Formatted context block or empty string
 */
export function formatStrainContext(strains, constraints = null) {
  const excluded = constraints && constraints.excludedTypes ? [...constraints.excludedTypes] : [];
  const hasStrains = strains && strains.length > 0;
  // Still emit the constraints note when retrieval returned nothing but the
  // user ruled a type out — so the model honors it either way.
  if (!hasStrains && excluded.length === 0) return "";

  let block = "";

  if (hasStrains) {
    const entries = strains.map((s) => {
      const parts = [`${s.strain_name} (${s.strain_type})`];
      // Lead with each strain's distinctive details so the model has real
      // differences to grab and won't fall back on stock poetry.
      if (s.effects.length > 0) {
        parts.push(`Effects: ${s.effects.join(", ")}`);
        parts.push(`Dominant effect: ${s.effects[0]}`);
      }
      if (s.flavor.length > 0) parts.push(`Flavor: ${s.flavor.join(", ")}`);
      if (s.rating) parts.push(`Community rating: ${s.rating}/5`);
      if (s.description) parts.push(`Lineage / background: ${s.description}`);
      return parts.join("\n  ");
    });
    block = `\n\n[STRAIN CONTEXT — retrieved from strain database. Describe each strain from THESE specifics (its own effects, flavor, lineage); do not reuse the same imagery across strains]\n${entries.join("\n\n")}`;
  }

  if (excluded.length > 0) {
    block += `\n\n[USER CONSTRAINTS — the person has ruled these OUT: ${excluded.join(", ")}. Do not recommend an excluded type as a match. If you offer one as a deliberate exception, you MUST say so honestly and explain how to get the wanted effect from it.]`;
  }

  return block;
}

// ─── Strain name resolver (Phase 2.5) ───────────────────────────────
// Precise name→row resolution for the SAVE path. Unlike searchStrains
// (which scores loosely so it can pull context cards from a sentence), the
// resolver is strict: it must not let a loose substring match override a
// better tier. If nothing clears the bar it returns null, and the caller
// saves the literal term the user said (a correct user-typed name beats a
// confident wrong match).

let normalizedCache = null;

/**
 * Normalize a name for matching: lowercase, strip hyphens/punctuation,
 * collapse whitespace. "Northern-Lights" → "northern lights".
 */
export function normalizeStrainName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadNormalized() {
  if (normalizedCache) return normalizedCache;
  normalizedCache = loadStrains().map((s) => {
    const norm = normalizeStrainName(s.strain_name);
    return {
      strain_name: s.strain_name,
      strain_type: s.strain_type,
      _norm: norm,
      _tokens: new Set(norm.split(" ").filter(Boolean)),
    };
  });
  return normalizedCache;
}

/**
 * Resolve a free-text strain phrase to a dataset row, strictly.
 *
 * Tiers, highest priority first:
 *   1. exact normalized equality
 *   2. dataset name startsWith the query (at a word boundary)
 *   3. token-subset: every query token is a whole token in the name
 *      (only for multi-token queries, so a single common word like
 *      "purple" can't drag in a random purple strain)
 *
 * @param {string} query
 * @returns {{ strain_name: string, strain_type: string, tier: string } | null}
 */
export function resolveStrainName(query) {
  const q = normalizeStrainName(query);
  if (!q) return null;
  const qTokens = q.split(" ").filter(Boolean);
  if (qTokens.length === 0) return null;

  const strains = loadNormalized();
  let prefixHit = null;
  let subsetHit = null;

  for (const s of strains) {
    if (s._norm === q) {
      // Exact always wins — return immediately.
      return { strain_name: s.strain_name, strain_type: s.strain_type, tier: "exact" };
    }
    if (!prefixHit && s._norm.startsWith(q + " ")) prefixHit = s;
    if (!subsetHit && qTokens.length >= 2 && qTokens.every((t) => s._tokens.has(t))) {
      subsetHit = s;
    }
  }

  const hit = prefixHit || subsetHit;
  if (!hit) return null;
  return {
    strain_name: hit.strain_name,
    strain_type: hit.strain_type,
    tier: prefixHit ? "prefix" : "subset",
  };
}

/**
 * Closest-match "did you mean" resolver (P1, read-only). Returns the single
 * best fuzzy DB-name match for a token/phrase above a high confidence bar
 * (normalized Levenshtein similarity ≥ 0.8), else null. NEVER used to mutate
 * retrieval or the save path — only to surface a gentle spelling suggestion.
 *
 * @param {string} query
 * @returns {{ strain_name: string, similarity: number } | null}
 */
export function closestStrainName(query) {
  const q = normalizeStrainName(query);
  if (!q || q.length < 4) return null;

  const names = loadNormalized();
  let best = null;
  let bestSim = 0;
  for (const s of names) {
    const longer = Math.max(q.length, s._norm.length);
    // Prefilter: similarity ≥ 0.8 means distance ≤ 20% of the longer string.
    const maxDist = Math.floor(longer * 0.2);
    const d = lev(q, s._norm, maxDist);
    if (d > maxDist) continue;
    const sim = 1 - d / longer;
    if (sim > bestSim) {
      bestSim = sim;
      best = s;
      if (sim === 1) break;
    }
  }

  if (best && bestSim >= 0.8) {
    return { strain_name: best.strain_name, similarity: bestSim };
  }
  return null;
}

let exactNameSet = null;
function getExactNameSet() {
  if (exactNameSet) return exactNameSet;
  exactNameSet = new Set(loadNormalized().map((s) => s._norm));
  return exactNameSet;
}

let exactNameMap = null;

/**
 * Exact-equality name lookup (normalized). O(1) per call — safe to run over
 * every n-gram of a message. Used by the save path to find a real strain
 * name EMBEDDED in sentence scaffolding ("bro you didn't save blue dream")
 * without any fuzzy risk: it fires only on a verbatim dataset name.
 *
 * @param {string} phrase
 * @returns {{ strain_name: string, strain_type: string, tier: "exact" } | null}
 */
export function resolveExactName(phrase) {
  if (!exactNameMap) {
    exactNameMap = new Map();
    for (const s of loadNormalized()) {
      if (!exactNameMap.has(s._norm)) exactNameMap.set(s._norm, s);
    }
  }
  const q = normalizeStrainName(phrase);
  const hit = q ? exactNameMap.get(q) : null;
  return hit
    ? { strain_name: hit.strain_name, strain_type: hit.strain_type, tier: "exact" }
    : null;
}

/**
 * Scan a message for an apparent strain reference the user MISSPELLED, and
 * return the single best "did you mean" — { wrote, suggestion, similarity } —
 * or null. Read-only surface for the context block (P1); never mutates
 * retrieval or the save path. Skips phrases that are already exact DB names
 * (so a correctly-typed strain is never "corrected" into a different one).
 */
export function suggestStrainCorrection(message) {
  const toks = String(message || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const cands = new Set();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].length >= 5) cands.add(toks[i]);
    if (i + 1 < toks.length) cands.add(toks[i] + " " + toks[i + 1]); // adjacent bigram
  }

  const exact = getExactNameSet();
  let best = null;
  let bestSim = 0;
  let budget = 150; // cap work in the request path
  for (const cand of cands) {
    if (budget-- <= 0) break;
    const norm = normalizeStrainName(cand);
    if (!norm || exact.has(norm)) continue; // already a real, correctly-typed name
    const hit = closestStrainName(cand);
    if (hit && normalizeStrainName(hit.strain_name) !== norm && hit.similarity > bestSim) {
      bestSim = hit.similarity;
      best = { wrote: cand, suggestion: hit.strain_name, similarity: hit.similarity };
    }
  }

  // Strong but not exact — fire only on a clear single best correction.
  if (best && bestSim >= 0.84 && bestSim < 1) return best;
  return null;
}
