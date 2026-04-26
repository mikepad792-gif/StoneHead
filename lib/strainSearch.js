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
import { fileURLToPath } from "url";

const _currentFile = fileURLToPath(import.meta.url);
const _currentDir = path.dirname(_currentFile);

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
 * Search strains by keyword matching against effects, flavors, type, and name.
 * Returns top 2-3 matches sorted by relevance score.
 *
 * @param {string} userMessage - The user's message text
 * @returns {Array} Top matching strains (max 3)
 */
export function searchStrains(userMessage) {
  const strains = loadStrains();
  const words = userMessage
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words.length === 0) return [];

  const scored = strains
    .map((strain) => {
      let score = 0;

      // Match against strain name (highest weight)
      const nameLower = strain.strain_name.toLowerCase();
      for (const word of words) {
        if (nameLower.includes(word)) score += 3;
      }

      // Match against effects
      for (const effect of strain.effects) {
        for (const word of words) {
          if (effect.includes(word)) score += 2;
        }
      }

      // Match against flavors
      for (const flav of strain.flavor) {
        for (const word of words) {
          if (flav.includes(word)) score += 2;
        }
      }

      // Match against type
      for (const word of words) {
        if (strain.strain_type === word) score += 2;
      }

      // Partial match on description (lower weight)
      if (strain.description) {
        const descLower = strain.description.toLowerCase();
        for (const word of words) {
          if (descLower.includes(word)) score += 1;
        }
      }

      return { ...strain, score };
    })
    .filter((s) => s.score > 0)
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
    if (s.effects.length > 0) parts.push(`Effects: ${s.effects.join(", ")}`);
    if (s.flavor.length > 0) parts.push(`Flavor: ${s.flavor.join(", ")}`);
    if (s.description) parts.push(`Description: ${s.description}`);
    return parts.join("\n  ");
  });

  return `\n\n[STRAIN CONTEXT — retrieved from strain database, riff on these naturally]\n${entries.join("\n\n")}`;
}
