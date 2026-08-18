// lib/historySearch.js
// Server-side keyword matching against cannabis_history.json
// Matches user messages against inject_triggers on each history entry.
// Returns top matches with short or long content for context injection.
//
// DATA FILE: Expects cannabis_history.json at ../data/cannabis_history.json

import { loadDataFile } from "./dataFile.js";

let historyCache = null;

/**
 * Normalize text to space-padded, space-separated alphanumeric tokens.
 *
 * WORD BOUNDARIES, IN ALL THREE PASSES (Addendum D2). Every match in this file
 * used to be `String.includes`, which is a SUBSTRING test:
 *
 *   tag "la"   matched inside p·la·ce, ·la·ter, p·la·nt
 *   tag "rap"  matched inside the·rap·y, g·rap·e, w·rap·ped
 *   tag "book" matched inside face·book
 *   trigger "og" matched inside l·og·ic, pr·og·ress, rec·og·nize
 *   trigger "pot" matched inside ·pot·ential, s·pot, ·pot·hole
 *
 * Padding both sides and testing for ` needle ` gives whole-word matching for
 * single words and phrase matching for multi-word triggers ("og kush", "war on
 * drugs") in one operation.
 *
 * It also makes the TAG pass work at all for the first time. Tags are stored
 * underscored — `Bob_Marley`, `origin_story`, `Blue_Dream` — so
 * `msgLower.includes(tag)` could never match natural text. Roughly 90% of the
 * tag vocabulary was silently dead, and the handful that did fire were the
 * bare two- and three-letter ones above, i.e. exactly the wrong half. Under
 * D1 tags can no longer admit an entry on their own, so waking them up affects
 * ranking only.
 */
function normalize(text) {
  return ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Whole-word / whole-phrase containment. `hay` must already be normalized. */
function containsPhrase(hay, needle) {
  const n = normalize(needle).trim();
  return n.length > 0 && hay.includes(` ${n} `);
}

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
    // Pre-normalized for fast matching. Trimmed here because the haystack
    // carries the padding, not the needle.
    _triggers_norm: (entry.inject_triggers || []).map((t) => normalize(t).trim()).filter(Boolean),
    _tags_norm: (entry.tags || []).map((t) => normalize(t).trim()).filter(Boolean),
    _title_norm: normalize(entry.title),
  }));

  return historyCache;
}

// How many recently-injected entry ids to carry as a suppression set.
// Addendum D4 asks for the last 3-5 distinct entries: long enough that nobody
// sees the same origin story twice in a sitting, short enough that a genuine
// re-ask later can surface it again. Thread-scoped and window-bounded, so it
// is never permanent.
const SEEN_LIMIT = 5;

// The title pass is a TIEBREAKER, not an admission ticket (Addendum D3). It
// used to add +2 per matching word with no ceiling, so a long message
// accumulated title points indefinitely and two coincidental hits cleared the
// threshold by themselves. One flat bump now, however many words match.
//
// This is also the dial to loosen first if D1-D3 have tightened scoring too
// far and real history questions start missing.
const TITLE_BONUS_MAX = 2;

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
 * A TRIGGER MATCH IS REQUIRED, and it did not used to be (Addendum D1). The
 * filter read `score >= 3` with a comment claiming it required a trigger, but
 * nothing checked: a tag match (+1) plus a title-word match (+2) reaches 3 on
 * its own, and two coincidental title words reach 4. So "i love that old
 * reggae music my dad played" pulled a Bubba Kush origin story — `that`
 * appears in the title, one tag appears somewhere in the sentence, and neither
 * has anything to do with what was said. That is the July 26 diagnosis, where
 * a free-will question pulled the Chemdawg / OG Kush / Sour Diesel material;
 * the fix was written down and never shipped.
 *
 * inject_triggers is the curated "this entry is relevant when someone says
 * this" list, and it is the only signal here that means it. Tags and titles
 * are both incidental-collision surfaces, so they rank and never admit.
 *
 * Three defects were compounding — the missing trigger requirement (D1),
 * substring instead of word matching (D2, see normalize()), and an uncapped
 * title contribution (D3). Together they are why history fired on messages
 * with nothing to do with cannabis. Expect this to fire a LOT less; that is
 * the intent, and TITLE_BONUS_MAX is the dial to loosen first if real history
 * questions start missing.
 *
 * @param {string} userMessage - The user's message text
 * @param {{ exclude?: string[] }} [opts] - entry ids already injected in this
 *        thread; see recentHistoryIds(). Excluded from the candidate set.
 * @returns {Array} Top matching history entries (max 2)
 */
export function searchHistory(userMessage, opts = {}) {
  const entries = loadHistory();
  const exclude = new Set(opts.exclude || []);
  const msgNorm = normalize(userMessage);
  const words = msgNorm.trim().split(/\s+/).filter((w) => w.length > 2);

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
      for (const trigger of entry._triggers_norm) {
        if (msgNorm.includes(` ${trigger} `)) {
          // Longer trigger phrases = higher confidence
          const wordCount = trigger.split(" ").length;
          score += wordCount >= 2 ? 5 : 3;
          triggerHits++;
        }
      }

      // Tag matching (lower weight, catches broader topics)
      for (const tag of entry._tags_norm) {
        if (msgNorm.includes(` ${tag} `)) {
          score += 1;
        }
      }

      // Title word matching — capped (D3). Resonance between the message and
      // an entry's title breaks a tie between two candidates that both cleared
      // the trigger gate; it is not evidence on its own, and it certainly is
      // not evidence that scales with how long the message was.
      const titleHit = words.some(
        (word) => word.length > 3 && entry._title_norm.includes(` ${word} `)
      );
      if (titleHit) score += TITLE_BONUS_MAX;

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

  // THE CONVERSATIONAL FRAMING STAYS (Addendum D6). Telling the model to weave
  // this in "like you lived through it" is what makes history land as anecdote
  // instead of a lookup, and the register is the product — "according to my
  // database" would be a worse answer to a question somebody actually asked.
  //
  // What it was missing is the other half. That instruction shape is the same
  // one that produced "The Loops ties it together with something sweet" on the
  // strain path: grounded scaffolding, confident elaboration, one voice, no
  // seam. So the block now says where the edge of what it knows is, which is
  // the honest-miss discipline (hit / miss / not_attempted) applied to a
  // surface that never had it.
  return `\n\n[HISTORY CONTEXT #${refs} — cannabis history from the database, weave this in naturally like you lived through it or heard about it from someone who did. Don't invent detail that isn't here — no dates, names, or specifics beyond what's in this block. If you only have the short version, that's all you have, and saying less is fine.]\n${blocks.join("\n\n")}`;
}
