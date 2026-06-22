// lib/frameDetect.js
// StoneHead — Frame detection (Phase 2)
//
// Rule-based, in-path, no API call, no added latency. Runs on each incoming
// message against the last two exchanges. Returns { frame, confidence }.
//
// Frame taxonomy (aligned with The Third):
//   breakthrough | challenge | friction | trust-building | routine | grounding
//   (CHANGE 1: "reorientation" was renamed to "grounding")
//
// CHANGE 2: returns a confidence so the F Gate can soft-allow on low confidence
//           instead of hard-blocking useful content. There is NO default-to-routine;
//           an unmatched message returns { frame: "unknown", confidence: "low" }.
// CHANGE 3: Grounding uses implicit-stress cues (not just the word "stressed");
//           Breakthrough is a conservative rule that is ALWAYS low-confidence, so
//           the Rumi moment (which requires high-confidence Breakthrough) stays
//           dormant until the Phase 3 LLM classifier rather than mistiming.
//
// Upgrades to an LLM classification call when StoneHead migrates to The Third's
// retrieval layer (same six categories).

export const FRAMES = [
  "breakthrough",
  "challenge",
  "friction",
  "trust-building",
  "routine",
  "grounding",
];

// ─── Cue lists ──────────────────────────────────────────────────────
const FRICTION_CUES = [
  "didn't work", "didnt work", "did not work", "felt bad", "not what i expected",
  "too much", "too strong", "didn't like", "didnt like", "disappointing",
  "made me anxious", "made it worse", "wasn't it", "wasnt it", "regret",
];

// Explicit medical / science / mechanism framing → research mode.
// Wins over Grounding on overlap (a dosing question is Challenge; an
// exhausted-life-context line is Grounding).
const CHALLENGE_CUES = [
  "pain", "anxiety", "dose", "dosage", "mg", "thc", "cbd", "thc:cbd",
  "gout", "medical", "terpene", "terpenes", "myrcene", "limonene", "linalool",
  "lineage", "genetics", "cross of", "parent strain", "how does", "why does",
  "what makes", "mechanism", "cannabinoid", "entourage",
];

// Implicit life-context stress. "Strong" cues raise confidence to high so the
// full Grounding block (present, not informative) applies; softer/single cues
// stay low so the gate soft-allows.
const GROUNDING_STRONG = [
  "rough day", "rough week", "stressed", "overwhelmed", "burnt out", "burned out",
  "exhausted", "drained", "falling apart", "breaking down",
];
const GROUNDING_SOFT = [
  "long day", "can't stop thinking about", "cant stop thinking about",
  "too much going on", "a lot going on", "tired", "worn out", "not okay", "not ok",
];

const ROUTINE_CUES = [
  "cost", "how much", "price", "cheap", "where to buy", "where can i buy",
  "dispensary", "near me", "in stock", "available", "$",
];

// Reflective phrases used by the conservative Breakthrough rule.
const REFLECTIVE_CUES = [
  "makes me think", "i wonder", "what's the point", "whats the point",
  "feels like", "kind of beautiful", "kinda beautiful", "it's like everything",
  "makes me realize", "never thought about it",
];

// Words that mean the current message is itself a strain query (so the
// "product question is settled" condition for Breakthrough is NOT met).
const STRAIN_QUERY_CUES = [
  "strain", "indica", "sativa", "hybrid", "recommend", "what should i",
  "good for", "suggest", "which one", "try", "pick",
];

function hasAny(text, cues) {
  return cues.some((c) => text.includes(c));
}

/**
 * Detect the relational frame for the current turn.
 *
 * @param {string} message  - the current user message (raw text)
 * @param {Array}  history  - prior messages [{ role, content }], chronological
 * @returns {{ frame: string, confidence: "high" | "low" }}
 */
export function detectFrame(message, history = []) {
  const text = (message || "").toLowerCase();
  const msgCount = history.length;

  // 1. Friction — a bad experience overrides everything.
  if (hasAny(text, FRICTION_CUES)) {
    return { frame: "friction", confidence: "high" };
  }

  // 2. Challenge — explicit medical/science framing (wins over Grounding).
  if (hasAny(text, CHALLENGE_CUES)) {
    return { frame: "challenge", confidence: "high" };
  }

  // 3. Grounding — implicit life-context stress (CHANGE 3).
  if (hasAny(text, GROUNDING_STRONG)) {
    return { frame: "grounding", confidence: "high" };
  }
  if (hasAny(text, GROUNDING_SOFT)) {
    return { frame: "grounding", confidence: "low" };
  }

  // 4. Routine — price / availability.
  if (hasAny(text, ROUTINE_CUES)) {
    return { frame: "routine", confidence: "high" };
  }

  // 5. Breakthrough — conservative, ALWAYS low-confidence (CHANGE 3).
  //    Needs depth + a settled product question + a reflective turn.
  const deepEnough = msgCount >= 8; // ~4 exchanges in
  const reflective = hasAny(text, REFLECTIVE_CUES);
  const productSettled = !hasAny(text, STRAIN_QUERY_CUES);
  if (deepEnough && reflective && productSettled) {
    return { frame: "breakthrough", confidence: "low" };
  }

  // 6. Trust-building — first 3 messages of a new thread (structural).
  if (msgCount < 6) {
    return { frame: "trust-building", confidence: "high" };
  }

  // 7. No strong match — do NOT default to routine (CHANGE 2). Low confidence
  //    routes the F Gate to its soft-allow policy.
  return { frame: "unknown", confidence: "low" };
}

/**
 * Whether the current turn is a settled, non-product moment — used by the
 * caller to decide if a Breakthrough/Challenge philosophy beat may fire.
 */
export function isProductSettled(message) {
  return !hasAny((message || "").toLowerCase(), STRAIN_QUERY_CUES);
}
