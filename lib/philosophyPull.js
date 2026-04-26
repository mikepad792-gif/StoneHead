// lib/philosophyPull.js
// Contextual philosophy quote injection from stonehead_philosophy.json
// Pulls periodically (not every message) via tag matching
// Stone Head attributes philosophers in stoner style, never academic style
//
// DATA FILE: Expects stonehead_philosophy.json at ../data/stonehead_philosophy.json
// relative to this file. Copy from dev kit during project setup.

import fs from "fs";
import path from "path";

let philosophyCache = null;

// Tag-to-keyword mapping for contextual matching
const TAG_KEYWORDS = {
  consciousness: ["consciousness", "aware", "awake", "mind", "think", "thinking", "brain", "conscious"],
  nature: ["nature", "trees", "ocean", "mountain", "earth", "sky", "sun", "moon", "river", "forest", "outside"],
  self: ["self", "identity", "who am i", "myself", "soul", "ego", "inner", "finding myself"],
  freedom: ["freedom", "free", "escape", "chains", "cage", "liberation", "trapped", "break free"],
  truth: ["truth", "real", "honest", "lie", "genuine", "authentic", "fake"],
  wisdom: ["wisdom", "wise", "knowledge", "learn", "understand", "lesson", "insight"],
  silence: ["silence", "quiet", "still", "calm", "noise", "peace", "solitude", "alone"],
  simplicity: ["simple", "simplicity", "minimal", "less", "enough", "basic", "uncomplicated"],
  peace: ["peace", "peaceful", "calm", "serene", "harmony", "balance", "tranquil", "chill", "relax"],
  existence: ["existence", "exist", "being", "alive", "living", "life", "meaning", "purpose", "why"],
  life: ["life", "living", "alive", "death", "born", "experience", "journey"],
  reality: ["reality", "real", "illusion", "perception", "world", "universe", "simulation"],
  perception: ["perception", "see", "perspective", "lens", "view", "looking", "observe"],
  being: ["being", "present", "moment", "now", "here", "existence", "am"],
  flow: ["flow", "water", "river", "stream", "movement", "moving", "change", "current"],
  impermanence: ["impermanence", "temporary", "change", "changing", "nothing lasts", "passing", "fleeting", "letting go"],
  connection: ["connection", "connected", "together", "relationship", "bond", "oneness", "unity"],
  present: ["present", "moment", "now", "today", "right now", "here", "mindful"],
  awareness: ["awareness", "aware", "notice", "attention", "mindful", "conscious", "woke"],
  mind: ["mind", "mental", "thought", "thoughts", "thinking", "brain", "head"],
  change: ["change", "changing", "different", "transform", "evolve", "grow", "growth", "new"],
  time: ["time", "past", "future", "yesterday", "tomorrow", "clock", "moment", "forever"],
};

/**
 * Load philosophy quotes. Cached after first load.
 */
function loadPhilosophy() {
  if (philosophyCache) return philosophyCache;

  const filePath = path.join(__dirname, "../data/stonehead_philosophy.json");
  philosophyCache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return philosophyCache;
}

/**
 * Determine whether to pull a philosophy quote for this exchange.
 * Targets roughly 1 in 4 messages — enough to feel natural,
 * not so frequent it becomes a gimmick.
 *
 * @param {number} daily_message_count - Current message count for the day
 * @returns {boolean}
 */
export function shouldPullPhilosophy(daily_message_count) {
  // Pull on every ~4th message, with some randomness
  // First message never gets a quote (let the conversation start naturally)
  if (daily_message_count <= 1) return false;
  return Math.random() < 0.25;
}

/**
 * Find a contextually relevant quote by matching user message keywords to tags.
 * Falls back to a random "general" tagged quote if no thematic match.
 *
 * @param {string} userMessage - The user's message text
 * @returns {object|null} { quote, author, tradition, tags } or null
 */
export function pullPhilosophy(userMessage) {
  const quotes = loadPhilosophy();
  const msgLower = userMessage.toLowerCase();

  // Score each tag by how many of its keywords appear in the message
  const tagScores = {};
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    let hits = 0;
    for (const kw of keywords) {
      if (msgLower.includes(kw)) hits++;
    }
    if (hits > 0) tagScores[tag] = hits;
  }

  // Get the best matching tags, sorted by score
  const matchedTags = Object.entries(tagScores)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  let pool = [];

  if (matchedTags.length > 0) {
    // Find quotes that share any of the top matched tags
    const topTags = new Set(matchedTags.slice(0, 3));
    pool = quotes.filter((q) => q.tags.some((t) => topTags.has(t)));
  }

  // Fallback to general quotes if no thematic match
  if (pool.length === 0) {
    pool = quotes.filter((q) => q.tags.includes("general"));
  }

  // Still nothing — pick from all quotes
  if (pool.length === 0) {
    pool = quotes;
  }

  // Random pick from the pool
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return pick;
}

/**
 * Format a philosophy quote for injection into the AI context.
 * Instructs Stone Head to attribute in stoner style, not academic.
 *
 * @param {object} quote - { quote, author, tradition, tags }
 * @returns {string} Formatted philosophy context block
 */
export function formatPhilosophyContext(quote) {
  if (!quote) return "";

  return (
    `\n\n[PHILOSOPHY PULL — weave this in naturally if it fits. ` +
    `Attribute ${quote.author} by name but in stoner style, not academic. ` +
    `Say it like you're telling a friend about something that blew your mind.]\n` +
    `"${quote.quote}" — ${quote.author}`
  );
}
