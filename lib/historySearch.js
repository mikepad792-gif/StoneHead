// lib/historySearch.js
// Server-side keyword matching against cannabis_history.json
// Matches user messages against inject_triggers on each history entry.
// Returns top matches with short or long content for context injection.
//
// DATA FILE: Expects cannabis_history.json at ../data/cannabis_history.json

import { loadDataFile } from "./dataFile.js";

let historyCache = null;

/**
 * Load and cache history data on first call.
 * Each entry: { id, slug, title, short, long, era, category, figures,
 *               strains_linked, regions, state_country, movements,
 *               tags, inject_triggers, related_entries }
 */
function loadHistory() {
  if (historyCache) return historyCache;

  const raw = loadDataFile("cannabis_history.json");

  historyCache = raw.map((entry) => ({
    ...entry,
    // Pre-lowercase all triggers for fast matching
    _triggers_lower: (entry.inject_triggers || []).map((t) => t.toLowerCase()),
    _tags_lower: (entry.tags || []).map((t) => t.toLowerCase()),
  }));

  return historyCache;
}

// How many recently-injected entry ids to carry as a suppression set.
// Sized to the thread history window chat-send already loads (20 messages,
// ~10 turns) — far enough back that a person doesn't see the same origin
// story twice in one sitting, short enough that a genuinely relevant entry
// becomes available again later in a long conversation.
const SEEN_LIMIT = 8;

// Machine-readable ids on the injected block, so which entries a thread has
// already seen can be replayed out of history rather than stored. Same
// approach as the post-crisis window and lastResolvedStrain: no schema
// change, and no stored value that can disagree with the code that wrote it.
const HISTORY_REF_RE = /\[HISTORY CONTEXT #([a-z0-9_,]+)/gi;

/**
 * Search history entries by matching user message against inject_triggers.
 * Uses phrase matching first (multi-word triggers), then individual word matching.
 * Returns top 1-2 matches sorted by relevance score.
 *
 * A TRIGGER MATCH IS REQUIRED, and it did not used to be. The filter read
 * `score >= 3` with a comment claiming it required a trigger, but nothing
 * checked: a tag match (+1) plus a title-word match (+2) reaches 3 on its own.
 * So "i love that old reggae music my dad played" pulled a Bubba Kush origin
 * story — `that` appears in the title, one tag appears somewhere in the
 * sentence, and neither has anything to do with what was said. That is the
 * July 26 diagnosis; the fix was written down and never shipped. Triggers are
 * the curated "this entry is relevant when someone says this" list, and they
 * are the only signal that means it.
 *
 * @param {string} userMessage - The user's message text
 * @param {{ exclude?: string[] }} [opts] - entry ids already injected in this
 *        thread; see recentHistoryIds(). Excluded from the candidate set.
 * @returns {Array} Top matching history entries (max 2)
 */
export function searchHistory(userMessage, opts = {}) {
  const entries = loadHistory();
  const exclude = new Set(opts.exclude || []);
  const msgLower = userMessage.toLowerCase().replace(/[^a-z0-9\s\-']/g, "");
  const words = msgLower.split(/\s+/).filter((w) => w.length > 2);

  if (words.length === 0) return [];

  const scored = entries
    // Repeat suppression, applied BEFORE scoring so a suppressed entry can't
    // out-rank the alternative that should surface instead.
    .filter((entry) => !exclude.has(entry.id))
    .map((entry) => {
      let score = 0;
      let triggerHits = 0;

      // Phrase matching against triggers (highest weight)
      // Multi-word triggers like "War on Drugs" or "OG Kush" get priority
      for (const trigger of entry._triggers_lower) {
        if (msgLower.includes(trigger)) {
          // Longer trigger phrases = higher confidence
          const wordCount = trigger.split(/\s+/).length;
          score += wordCount >= 2 ? 5 : 3;
          triggerHits++;
        }
      }

      // Tag matching (lower weight, catches broader topics)
      for (const tag of entry._tags_lower) {
        if (msgLower.includes(tag)) {
          score += 1;
        }
      }

      // Title word matching (medium weight)
      const titleLower = entry.title.toLowerCase();
      for (const word of words) {
        if (titleLower.includes(word) && word.length > 3) {
          score += 2;
        }
      }

      return { ...entry, score, triggerHits };
    })
    // Both conditions, and they are not redundant: triggerHits is the
    // requirement the old comment described, and score >= 3 keeps the
    // threshold honest if trigger weights are ever retuned downward.
    .filter((e) => e.triggerHits > 0 && e.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return scored;
}

/**
 * Which history entries this thread has already been shown, newest first.
 *
 * REPEAT SUPPRESSION IS THE OTHER HALF, and without it the trigger fix alone
 * is not enough: a real trigger word said twice in a conversation surfaces the
 * same top-scoring entry twice, because scoring is deterministic and nothing
 * anywhere tracked what a person had already seen. Deterministic ranking is
 * correct; showing somebody the Prop 215 story four times is not.
 *
 * Read out of the stored augmented messages rather than a new column. The ids
 * are stamped into the injected block by formatHistoryContext().
 *
 * @param {Array<{role:string, content_augmented?:string|null}>} history
 * @param {number} [cap]
 * @returns {string[]} entry ids, most recently injected first
 */
export function recentHistoryIds(history, cap = SEEN_LIMIT) {
  const seen = [];
  const messages = (history || []).filter((m) => m && m.content_augmented);

  // Newest first, so the cap keeps the most recent injections.
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = String(messages[i].content_augmented);
    HISTORY_REF_RE.lastIndex = 0; // the /g flag makes this stateful
    let m;
    while ((m = HISTORY_REF_RE.exec(text)) !== null) {
      for (const id of m[1].split(",")) {
        const trimmed = id.trim();
        if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
      }
    }
    if (seen.length >= cap) break;
  }

  return seen.slice(0, cap);
}

/**
 * Format matched history entries into the [HISTORY CONTEXT] block
 * for injection into the user message before sending to the AI.
 * Uses the short version to keep token count reasonable.
 *
 * @param {Array} entries - Matched history entries from searchHistory()
 * @returns {string} Formatted context block or empty string
 */
export function formatHistoryContext(entries) {
  if (!entries || entries.length === 0) return "";

  const blocks = entries.map((e) => {
    let block = `${e.title} (${e.era})`;
    block += `\n  ${e.short}`;
    if (e.figures && e.figures.length > 0) {
      block += `\n  Key figures: ${e.figures.join(", ")}`;
    }
    if (e.strains_linked && e.strains_linked.length > 0) {
      block += `\n  Related strains: ${e.strains_linked.slice(0, 5).join(", ")}`;
    }
    return block;
  });

  // The `#id,id` stamp is what recentHistoryIds() replays out of
  // content_augmented on later turns. It rides inside the existing bracket so
  // it adds no line and reads as part of the same metadata marker the model
  // already ignores — the same convention as [STRAIN LOOKUP: …] and
  // [USER CONSTRAINTS — …].
  const refs = entries.map((e) => e.id).join(",");

  return `\n\n[HISTORY CONTEXT #${refs} — cannabis history from the database, weave this in naturally like you lived through it or heard about it from someone who did]\n${blocks.join("\n\n")}`;
}
