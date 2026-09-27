// lib/feedbackEligibility.js
// Which StoneHead replies can be rated with a thumbs up / down.
//
// NOT rateable:
//   - a reply to a SAFETY TURN: any user message the crisis layer scores at
//     tier 1 or above, or the substance layer does. Same test chat-send uses
//     for safetyMode, and a superset of the turns that carry a safety card.
//     Someone's worst night doesn't become training data.
//   - the under-13 reply (a fixed message, not a model reply).
//
// One rule, used in three places so they can't drift: chat-send (live turn),
// threads-messages (reload), and api/feedback.js (the server-side refusal).

import { detectCrisis } from "./crisisDetect.js";
import { detectSubstance } from "./substanceDetect.js";
import { UNDER_13_REPLY } from "./ageDetect.js";

// chat-send scores a turn against the most recent 20 messages only; the
// replay does the same so a reload agrees with what the live turn decided.
const HISTORY_WINDOW = 20;

/** True when this user message puts the turn in safety mode. */
export function isSafetyTurn(userContent, history = []) {
  return (
    detectCrisis(userContent, history).tier >= 1 ||
    detectSubstance(userContent).tier >= 1
  );
}

/**
 * Replays a thread oldest-first and returns the Set of assistant message ids
 * that can be rated. `messages`: [{ id, role, content }].
 */
export function rateableReplyIds(messages) {
  const ids = new Set();
  const history = [];
  let safety = false;
  for (const m of messages || []) {
    if (m.role === "user") {
      safety = isSafetyTurn(m.content, history.slice(-HISTORY_WINDOW));
      history.push({ role: "user", content: m.content });
      continue;
    }
    if (!safety && m.content && m.content.trim() && m.content !== UNDER_13_REPLY) ids.add(m.id);
    safety = false;
    history.push({ role: "assistant", content: m.content });
  }
  return ids;
}
