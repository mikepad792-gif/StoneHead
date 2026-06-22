// lib/saveIntent.js
// Cheap, no-LLM detection of "save / remember this" intent in a user
// message. The prefilter is what guarantees the database and Stone Head's
// spoken claim agree: rather than gating what the small model SAYS, we
// reliably FIRE the write whenever the user expresses the intent.
//
// Forward-compat (Phase 2 memory layer): detectSaveIntent returns a
// generic { type, value, frame } shape. Today it only resolves
// liked_strains; Phase 2 generalizes this exact path to arbitrary facts.

import { searchStrains } from "./strainSearch.js";

// Save/like cues. Lowercased substring match against the user message.
// Kept deliberately broad — the required strain-name match (below) is what
// prevents false positives, so a stray cue word alone never triggers a write.
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

/**
 * Detect a save/remember intent in a user message.
 *
 * Two-stage prefilter (no LLM):
 *   1. Does the message contain a save/like cue?
 *   2. AND does it name a known strain? (reuses strainSearch retrieval so
 *      this stays consistent with how strains get matched elsewhere)
 *
 * @param {string} message - The raw user message
 * @returns {{ type: string, value: object, frame: null } | null}
 *   null when no intent detected. On a hit, returns a forward-compatible
 *   shape, e.g. { type: "liked_strain", value: { strain_name, strain_type }, frame: null }
 */
export function detectSaveIntent(message) {
  if (!message || typeof message !== "string") return null;

  const lower = message.toLowerCase();
  const hasCue = SAVE_CUES.some((cue) => lower.includes(cue));
  if (!hasCue) return null;

  // Reuse the retrieval name-matching so detection agrees with what the
  // strain DB considers a real match. Top result is the best name hit.
  const matches = searchStrains(message);
  if (!matches || matches.length === 0) return null;

  const top = matches[0];
  return {
    type: "liked_strain",
    value: {
      strain_name: top.strain_name,
      strain_type: top.strain_type,
    },
    frame: null,
  };
}
