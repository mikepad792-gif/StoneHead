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
  // 1. Remove known scaffold/reasoning blocks WITH their contents.
  t = t.replace(
    /<(think|thinking|reasoning|reflection|ds_safety|safety|system|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  // 2. Remove any remaining tag-shaped tokens (opening/closing/self-closing).
  //    Only matches real tag shapes (`<word…>`), so "a < b" and "<3" survive.
  t = t.replace(/<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g, "");
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
