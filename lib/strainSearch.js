// lib/strainSearch.js
// Server-side keyword matching against cannabis_strains_2351.json
// Normalizes capital keys (Strain, Type, etc.) to snake_case on load
// Handles null/empty effects, flavors, descriptions (~4% of records)
//
// DATA FILE: Expects cannabis_strains_2351.json at ../data/strains.json
// relative to this file. During project setup, copy the dev kit's
// cannabis_strains_2351.json to data/strains.json.

import fs from "fs";
import path from "path";

let strainCache = null;

/**
 * Load and normalize strain data. Cached after first load.
 * Source keys: Strain, Type, Rating, Effects, Flavor, Description
 * Normalized: strain_name, strain_type, rating, effects, flavor, description
 */
function loadStrains() {
  if (strainCache) return strainCache;

  const filePath = path.join(__dirname, "../data/strains.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  strainCache = raw.map((s) => ({
    strain_name: String(s.Strain || "").trim(),
    strain_type: (s.Type || "").toLowerCase().trim(),
    rating: s.Rating || 0,
    effects: normalizeList(s.Effects),
    flavor: normalizeList(s.Flavor),
    description: s.Description && s.Description !== "None" ? s.Description.trim() : "",
  }));

  return strainCache;
}

/**
 * Normalize a comma-separated string to a lowercase array.
 * Handles null, "None", empty strings.
 */
function normalizeList(val) {
  if (!val || val === "None") return [];
  return val
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Search strains by keyword matching. Only returns results when the user's
 * message contains a strain NAME match — casual words like "relaxed" or
 * "happy" that match effects/flavors won't trigger retrieval on their own.
 * This lets the plant tab hold a normal conversation without pulling
 * strain cards on every message.
 *
 * @param {string} userMessage - The user's message text
 * @returns {Array} Top matching strains (max 3), empty if no name match
 */
export function searchStrains(userMessage) {
  const strains = loadStrains();
  const msgLower = userMessage.toLowerCase().replace(/[^a-z0-9\s\-]/g, "");
  const words = msgLower.split(/\s+/).filter((w) => w.length > 2);

  if (words.length === 0) return [];

  const scored = strains
    .map((strain) => {
      let score = 0;
      let nameHit = false;

      // Match against strain name (highest weight, required for retrieval)
      const nameLower = strain.strain_name.toLowerCase();
      // Check full name as phrase first (catches "Blue Dream", "OG Kush")
      if (msgLower.includes(nameLower) && nameLower.length > 2) {
        score += 5;
        nameHit = true;
      } else {
        // Fall back to word-level name matching
        for (const word of words) {
          if (word.length > 3 && nameLower.includes(word)) {
            score += 3;
            nameHit = true;
          }
        }
      }

      // Only score effects/flavors/type if there's already a name hit
      // This prevents "I feel relaxed" from pulling strains
      if (nameHit) {
        for (const effect of strain.effects) {
          for (const word of words) {
            if (effect.includes(word)) score += 2;
          }
        }

        for (const flav of strain.flavor) {
          for (const word of words) {
            if (flav.includes(word)) score += 2;
          }
        }

        for (const word of words) {
          if (strain.strain_type === word) score += 2;
        }
      }

      return { ...strain, score, nameHit };
    })
    .filter((s) => s.nameHit && s.score >= 3)
    .sort((a, b) => b.score - a.score || b.rating - a.rating)
    .slice(0, 3);

  return scored;
}

/**
 * Format matched strains into the [STRAIN CONTEXT] block for injection
 * into the user message before sending to the AI.
 *
 * @param {Array} strains - Matched strain objects from searchStrains()
 * @returns {string} Formatted context block or empty string
 */
export function formatStrainContext(strains) {
  if (!strains || strains.length === 0) return "";

  const entries = strains.map((s) => {
    const parts = [`${s.strain_name} (${s.strain_type})`];
    // Lead with each strain's distinctive details so the model has real
    // differences to grab and won't fall back on stock poetry.
    if (s.effects.length > 0) {
      parts.push(`Effects: ${s.effects.join(", ")}`);
      parts.push(`Dominant effect: ${s.effects[0]}`);
    }
    if (s.flavor.length > 0) parts.push(`Flavor: ${s.flavor.join(", ")}`);
    if (s.rating) parts.push(`Community rating: ${s.rating}/5`);
    if (s.description) parts.push(`Lineage / background: ${s.description}`);
    return parts.join("\n  ");
  });

  return `\n\n[STRAIN CONTEXT — retrieved from strain database. Describe each strain from THESE specifics (its own effects, flavor, lineage); do not reuse the same imagery across strains]\n${entries.join("\n\n")}`;
}
