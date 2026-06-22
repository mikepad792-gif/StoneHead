// lib/fGate.js
// StoneHead — The F Gate (Phase 2)
//
// Frame-addressed injection. Replaces content-addressed (keyword) injection:
// content fires when the relational moment is right, not when a word matches.
//
// The function signature is fixed. When StoneHead migrates to The Third's
// retrieval layer, the body is replaced by the encounter equation's W(m,c)
// calculation and frame filter — the calling code in chat-send does not change.
//
// CHANGE 1: "reorientation" → "grounding".
// CHANGE 2: low-confidence frames soft-allow useful content (session memories,
//           liked strains, strain context) and only withhold the deep content
//           (philosophy / history) that is jarring when mistimed. This replaces
//           the old hard default-to-routine, which made Stone Head go cold.

// Hard-block lists for HIGH-confidence frames.
const BLOCKED = {
  strain_context:   ["grounding", "friction"],
  philosophy:       ["routine", "grounding", "friction"],
  history:          ["routine", "grounding", "friction"],
  liked_strains:    ["routine"],
  session_memories: [], // always inject
};

// Content the soft-allow policy still withholds on low confidence.
const SOFT_WITHHELD = ["philosophy", "history"];

/**
 * Decide whether a content type may inject given the detected frame.
 *
 * @param {string} contentType - one of: session_memories | liked_strains |
 *                               strain_context | philosophy | history
 * @param {string} frame       - detected frame (e.g. "grounding")
 * @param {"high"|"low"} confidence - detector confidence
 * @returns {boolean} true = inject, false = withhold
 */
export function fGate(contentType, frame, confidence) {
  // Session memories are unconditional.
  if (contentType === "session_memories") return true;

  // CHANGE 2 — soft-allow: a low-confidence (or unknown) frame must not
  // hard-block useful content. Allow everything except the deep beats.
  if (confidence === "low") {
    return !SOFT_WITHHELD.includes(contentType);
  }

  const blocked = BLOCKED[contentType] || [];
  return !blocked.includes(frame);
}

/**
 * The Rumi moment: a philosophy beat in an expanded state. Never fires on a
 * keyword and never on low confidence — only on a high-confidence Breakthrough
 * or Challenge with the product question settled. With the current rule-based
 * detector Breakthrough is always low-confidence, so in practice this fires
 * only on high-confidence Challenge-with-settled-product until the Phase 3
 * classifier produces high-confidence Breakthrough.
 *
 * @param {string} frame
 * @param {"high"|"low"} confidence
 * @param {boolean} productSettled
 * @returns {boolean}
 */
export function canFireRumi(frame, confidence, productSettled) {
  if (confidence !== "high") return false;
  if (!productSettled) return false;
  return frame === "breakthrough" || frame === "challenge";
}
