// lib/titleGen.js
// Shared thread-title generator, used by the live path (api/chat-send.js)
// and the one-off sweep (api/backfill-titles.js).
//
// THE INPUT-SHAPE BUG THIS FIXES: the old live titler sent the exchange as
// real chat turns ([system, user, assistant]) and asked for a completion.
// A conversation that ENDS on an assistant turn reads as a live chat to
// continue, not data to title — so the model kept role-playing (or emitted
// scaffold like <ds_safety>, or started "writing a script for the task":
// "import re, sys, json"). With max_tokens: 15 the scaffold alone filled the
// budget, stripping left an empty title, and the thread froze on its default.
//
// The fix is the shape the backfill already used: serialize the transcript
// INTO one user message, so the model's only conversation is "here is a
// transcript, name it." Plus: token headroom for scaffold, output validation
// (a title that isn't a title is worse than no title — it also stops the
// lazy retry from ever firing again), and one in-call retry.

import { stripModelTags } from "./sanitize.js";
import { BLANK_REPLY_FALLBACK } from "./constants.js";
import { openrouterChat } from "./openrouter.js";
import { AI_MODEL_TITLE } from "./config.js";

// Scaffold headroom: the model may spend tokens on <ds_safety>/<think> before
// the actual title. 15 used to truncate to bare scaffold; 60 fits both.
const TITLE_MAX_TOKENS = 60;
const TITLE_TEMPERATURE = 0.3;
const TRANSCRIPT_CHAR_CAP = 1500;

export const TITLE_SYSTEM_PROMPT =
  "You will be shown a chat transcript. Name it in 3-5 plain English words — " +
  "a short noun phrase that names the subject. Output ONLY the title: no tags, " +
  "no XML, no angle brackets, no preamble, no explanation, no quotes, no " +
  "punctuation, no first person, not a sentence or a question, no code. " +
  "Good: Northern Lights for sleep. Bad: <ds_safety>. Bad: If youre looking for. " +
  "Bad: Does that make sense.";

/**
 * Serialize a transcript into the single user-message payload for the title
 * call. Filters out the blank-reply fallback line — it describes an
 * infrastructure hiccup, not the conversation. Returns "" when nothing
 * meaningful remains.
 *
 * @param {Array<{role:string, content:string}>} msgs - chronological
 * @returns {string}
 */
export function buildTitleTranscript(msgs) {
  return (msgs || [])
    .filter((m) => m && m.content && m.content.trim() !== BLANK_REPLY_FALLBACK)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, TRANSCRIPT_CHAR_CAP)
    .trim();
}

/**
 * Extract usable title text from a raw model return. A scaffold tag that
 * OPENS but never CLOSES means the return was truncated mid-reasoning —
 * whatever words follow the tag are the model thinking, not the title
 * (the "<ds_safety>assess the…" failure). Unlike the chat path, dropping
 * is safe here: the in-call retry and the lazy default-title retry both
 * get another shot.
 *
 * @param {string} raw
 * @returns {string} cleaned text, or "" when nothing trustworthy remains
 */
export function extractTitleText(raw) {
  if (!raw) return "";
  const t = String(raw);
  const openTag = /<([a-zA-Z][\w:.-]*)(?:\s[^<>]*)?(\/?)>/g;
  let m;
  while ((m = openTag.exec(t))) {
    if (m[2] === "/") continue; // self-closing
    if (!new RegExp(`</${m[1]}\\s*>`, "i").test(t)) return "";
  }
  return stripModelTags(t);
}

/**
 * Does the model's cleaned output actually look like a topic title?
 * Rejects the observed failure shapes: leaked scaffold, code lines
 * ("import re, sys, json"), role labels, sentences/questions, run-ons.
 * Rejection matters twice over — a stored non-title also stops the lazy
 * default-title retry from ever firing again.
 *
 * @param {string} t - already tag-stripped / quote-stripped / trimmed
 * @returns {boolean}
 */
export function looksLikeTitle(t) {
  if (!t || t.length < 3) return false;
  const words = t.split(/\s+/);
  if (words.length > 8) return false;
  // Code / markup artifacts: symbols no noun-phrase title contains.
  if (/[{}();=<>\[\]`#\\/_|]/.test(t)) return false;
  // A leading code keyword or role label means the model did something else.
  if (/^(import|from|def|function|print|console|return|var|let|const|user|assistant|system)\b/i.test(t)) return false;
  // Comma-chained fragments ("re, sys, json") aren't noun phrases.
  if ((t.match(/,/g) || []).length >= 2) return false;
  // Conversational openers = the model kept chatting instead of titling.
  // ("do" stays allowed: Do-Si-Dos is a real strain.)
  if (/^(if|so|well|okay|ok|yeah|hey|yo|sure|sorry|bro|i|you|does|is|are|was|what|why|how)\b/i.test(t)) return false;
  return true;
}

/**
 * Generate a topic title from a chronological transcript. One OpenRouter
 * call, one retry on unusable output. Returns the clean title or null —
 * callers leave the existing title alone on null (the lazy retry in
 * chat-send.js gets another shot with a fuller transcript next message).
 *
 * @param {Array<{role:string, content:string}>} msgs
 * @returns {Promise<string|null>}
 */
export async function generateTopicTitle(msgs) {
  const convo = buildTitleTranscript(msgs);
  if (!convo) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = "";
    try {
      const data = await openrouterChat(AI_MODEL_TITLE,
        [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          { role: "user", content: `TRANSCRIPT:\n${convo}` },
        ],
        {
          max_tokens: TITLE_MAX_TOKENS,
          temperature: TITLE_TEMPERATURE,
          // No reasoning: scaffold-before-title is exactly the failure the
          // validator exists to catch. Turn it off at the source too.
          reasoning: { enabled: false },
        }
      );
      if (!data) continue;
      raw = data.choices?.[0]?.message?.content || "";
    } catch (e) {
      console.error("title gen call failed:", e.message);
      continue;
    }

    const title = extractTitleText(raw)
      .replace(/["'`]/g, "")
      .replace(/[.?!:]+$/, "")
      .slice(0, 60)
      .trim();

    if (looksLikeTitle(title)) return title;

    // Log the RAW return so a bad title traces back to what the model
    // actually sent, not to a guess.
    console.warn(
      "title gen unusable output:",
      JSON.stringify({ attempt, raw_len: raw.length, raw_preview: raw.slice(0, 200) })
    );
  }
  return null;
}
