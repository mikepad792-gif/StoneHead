// lib/saveIntent.js
// Cheap, no-LLM detection of "save / remember this" intent in a user
// message. The prefilter is what guarantees the database and Stone Head's
// spoken claim agree: rather than gating what the small model SAYS, we
// reliably FIRE the write whenever the user expresses the intent.
//
// Phase 2.5: the resolver no longer fuzzy-matches the whole sentence (which
// once saved "Las Vegas Purple Kush Bx" for "grandaddy purp"). Instead it
// (1) extracts the strain phrase from the message, (2) resolves it strictly
// via resolveStrainName, and (3) if nothing clears the bar, saves the LITERAL
// term the user said with strain_type = null. A correct user-typed name beats
// a confident wrong match.
//
// Forward-compat (Phase 2 memory layer): detectSaveIntent returns a generic
// { type, value, frame } shape. Today it only resolves liked_strains.

import { resolveStrainName, normalizeStrainName } from "./strainSearch.js";

// Save/like cues. Lowercased substring match against the user message.
// Kept deliberately broad — the strain-phrase extraction below is what keeps
// false positives down.
const SAVE_CUES = [
  "save",
  "remember",
  "i love",
  "i like",
  "favorite",
  "favourite",
  "add ",
  "note that",
  "keep track",
  "i'm into",
  "im into",
  "a fan of",
];

// Obvious non-strain phrases that can follow a save cue — guards the literal
// fallback from storing junk like "save my progress".
const NON_STRAIN = new Set([
  "progress", "this", "that", "it", "my place", "my spot", "the chat",
  "this chat", "everything", "the convo", "the conversation", "your number",
]);

// Lead verbs/phrases stripped from the start of the message.
const LEAD_RE =
  /^(?:please\s+|can\s+you\s+|could\s+you\s+|hey\s+|yo\s+)?(?:save|remember|add|note(?:\s+that)?|keep\s+track\s+of|i\s+love|i\s+like|i'?m\s+into|i'?m\s+a\s+fan\s+of|a\s+fan\s+of|favou?rites?|faves?|fav|mark|make|set)\b/;
// Filler words stripped from the start after a lead.
const FILLER_RE = /^(?:that|the|a|an|my|this|one|strain|called|of|down)\s+/;

/**
 * Pull the likely strain phrase out of a save message.
 * "save grandaddy purp as a fav" → "grandaddy purp"
 * "remember i love northern lights" → "northern lights"
 */
function extractStrainPhrase(message) {
  // Keep letters/numbers/space/apostrophe/hyphen; drop other punctuation.
  let t = message.toLowerCase().replace(/[^\w\s'\-]/g, " ").replace(/\s+/g, " ").trim();

  // Strip leads + fillers until stable (handles "save that i love X").
  let prev;
  do {
    prev = t;
    t = t.replace(LEAD_RE, "").trim();
    t = t.replace(FILLER_RE, "").trim();
  } while (t !== prev);

  // Strip trailing "as a fav / to my favorites / ..." tails.
  t = t.replace(
    /\s+(?:as|to)\s+(?:a\s+|my\s+)?(?:fav|favs|fave|faves|favorite|favourite|favorites|favourites|list)\b.*$/,
    ""
  ).trim();
  // Strip trailing filler.
  t = t.replace(/\s+(?:strain|please|too|also|man|bro|dude)\s*$/, "").trim();

  return t.replace(/\s+/g, " ").trim();
}

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Detect a save/remember intent in a user message.
 *
 * @param {string} message - The raw user message
 * @returns {{ type: string, value: object, frame: null } | null}
 *   On a hit: { type:"liked_strain", value:{ strain_name, strain_type }, frame:null }
 *   strain_type is null when the name was taken literally (unresolved).
 */
export function detectSaveIntent(message) {
  if (!message || typeof message !== "string") return null;

  const lower = message.toLowerCase();
  const hasCue =
    SAVE_CUES.some((cue) => lower.includes(cue)) ||
    /\bfav(e|s|es|ourite|orite|ourites|orites)?\b/.test(lower);
  if (!hasCue) return null;

  const phrase = extractStrainPhrase(message);
  if (!phrase) return null;

  // 1. Strict resolve of the extracted phrase.
  let resolved = resolveStrainName(phrase);

  // 2. Fallback: a real multi-word strain name embedded anywhere in the
  //    message (handles imperfect extraction). resolveStrainName on the
  //    phrase already covers the clean case; this catches leftover filler.
  if (!resolved) {
    const embedded = resolveStrainName(phrase.split(" ").slice(0, 4).join(" "));
    if (embedded) resolved = embedded;
  }

  if (resolved) {
    return {
      type: "liked_strain",
      value: { strain_name: resolved.strain_name, strain_type: resolved.strain_type },
      frame: null,
    };
  }

  // 3. Nothing cleared the bar — save the literal term the user said, with a
  //    null type. Light guards keep obvious non-strains out.
  const normPhrase = normalizeStrainName(phrase);
  const wordCount = normPhrase.split(" ").filter(Boolean).length;
  if (
    normPhrase.length < 2 ||
    normPhrase.length > 40 ||
    wordCount > 5 ||
    NON_STRAIN.has(normPhrase)
  ) {
    return null;
  }

  return {
    type: "liked_strain",
    value: { strain_name: titleCase(normPhrase), strain_type: null },
    frame: null,
  };
}
