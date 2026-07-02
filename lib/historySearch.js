// lib/historySearch.js
// Server-side keyword matching against cannabis_history.json
// Matches user messages against inject_triggers on each history entry.
// Returns top matches with short or long content for context injection.
//
// DATA FILE: Expects cannabis_history.json at ../data/cannabis_history.json

import { createRequire } from "module";

// JSON import via createRequire — works under both esbuild's CJS output and
// plain Node ESM (no reliance on a bundler-provided __dirname).
const require = createRequire(import.meta.url);

let historyCache = null;

/**
 * Load and cache history data on first call.
 * Each entry: { id, slug, title, short, long, era, category, figures,
 *               strains_linked, regions, state_country, movements,
 *               tags, inject_triggers, related_entries }
 */
function loadHistory() {
  if (historyCache) return historyCache;

  const raw = require("../data/cannabis_history.json");

  historyCache = raw.map((entry) => ({
    ...entry,
    // Pre-lowercase all triggers for fast matching
    _triggers_lower: (entry.inject_triggers || []).map((t) => t.toLowerCase()),
    _tags_lower: (entry.tags || []).map((t) => t.toLowerCase()),
  }));

  return historyCache;
}

/**
 * Search history entries by matching user message against inject_triggers.
 * Uses phrase matching first (multi-word triggers), then individual word matching.
 * Returns top 1-2 matches sorted by relevance score.
 *
 * @param {string} userMessage - The user's message text
 * @returns {Array} Top matching history entries (max 2)
 */
export function searchHistory(userMessage) {
  const entries = loadHistory();
  const msgLower = userMessage.toLowerCase().replace(/[^a-z0-9\s\-']/g, "");
  const words = msgLower.split(/\s+/).filter((w) => w.length > 2);

  if (words.length === 0) return [];

  const scored = entries
    .map((entry) => {
      let score = 0;

      // Phrase matching against triggers (highest weight)
      // Multi-word triggers like "War on Drugs" or "OG Kush" get priority
      for (const trigger of entry._triggers_lower) {
        if (msgLower.includes(trigger)) {
          // Longer trigger phrases = higher confidence
          const wordCount = trigger.split(/\s+/).length;
          score += wordCount >= 2 ? 5 : 3;
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

      return { ...entry, score };
    })
    .filter((e) => e.score >= 3) // Require at least a trigger match
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return scored;
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

  return `\n\n[HISTORY CONTEXT — cannabis history from the database, weave this in naturally like you lived through it or heard about it from someone who did]\n${blocks.join("\n\n")}`;
}
