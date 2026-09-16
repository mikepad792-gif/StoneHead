// lib/sanitize.js
// Shared sanitizer for raw LLM output. Some providers wrap generations in
// safety/reasoning scaffolding (<ds_safety>…</ds_safety>, <think>…</think>);
// this strips it so an internal tag never reaches a title, a chat reply, a
// stored memory summary, or a core memory. Applied on EVERY model-output path.

/**
 * Strip leaked model scaffolding and any stray XML/HTML-ish tags from text.
 * Leaves casual prose and math ("a < b", "<3") untouched.
 *
 * @param {string} text
 * @returns {string} cleaned text ("" for empty/nullish input)
 */
export function stripModelTags(text) {
  if (!text) return "";
  let t = String(text);
  // 1. Remove ONLY genuine reasoning blocks with their contents — that content
  //    is never meant for the user. Do NOT block-remove <ds_safety>/<safety>:
  //    the model sometimes wraps the actual ANSWER in those, and deleting the
  //    contents would blank the whole reply. Those are handled as tags in (2),
  //    which keeps the words and drops only the tag.
  t = t.replace(
    /<(think|thinking|reasoning|reflection|scratchpad|monologue)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  // 2. Remove any remaining tag-shaped tokens (opening/closing/self-closing),
  //    keeping surrounding text. Only matches real tag shapes (`<word…>`), so
  //    "a < b" and "<3" survive.
  t = t.replace(/<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g, "");
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Replace em and en dashes with the punctuation they were standing in for.
 *
 * WHY THIS IS CODE AND NOT A PROMPT LINE
 * prompts/character.js asks him not to reach for the long dash, and that ask
 * did not hold: replies kept arriving with "the name isn't just a gimmick —
 * it earns it" in them, on a deploy that carried the rule. Instruction prose
 * throughout the prompt still models the habit, and a style request loses to
 * a few hundred lines quietly demonstrating the opposite.
 *
 * So it goes where stripModelTags already lives, for the same reason that
 * function exists: "Do not use <think> tags" was not enough either, and the
 * guarantee had to move into code. A regex does not care what the surrounding
 * prose is teaching.
 *
 * Ellipses are untouched. Trailing off is part of the voice and the character
 * file says so explicitly.
 *
 * @param {string} text
 * @returns {string} text with no em or en dashes
 */
export function stripLongDashes(text) {
  if (!text) return "";
  return (
    String(text)
      // Between digits it is a range, not a clause break. "4-6 hours" is what
      // was meant; "4, 6 hours" is a different and wrong sentence.
      .replace(/(\d)\s*[\u2014\u2013]\s*(?=\d)/g, "$1-")
      // Ending a line or the whole reply, the dash is a trail-off, and he
      // already has a way to write one.
      .replace(/\s*[\u2014\u2013]\s*(?=\n|$)/g, "...")
      // Following punctuation that already breaks the sentence, it is just
      // doubled. Drop it rather than stacking ", ," on top of a comma.
      .replace(/([,.;:!?])\s*[\u2014\u2013]\s*/g, "$1 ")
      // Opening a line, it is acting as a bullet.
      .replace(/(^|\n)\s*[\u2014\u2013]\s*/g, "$1")
      // Everything else is the comma it was standing in for.
      .replace(/\s*[\u2014\u2013]\s*/g, ", ")
  );
}
