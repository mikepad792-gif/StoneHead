// lib/extrasLookup.js
// StoneHead — Parallel reference lookup for dab knowledge + slang (Phase final).
//
// Brand-new domains with no existing reader to migrate — a small fresh reader
// is clean and independent of the strains.json reader. Plant tab only.
//
// Matching uses the SAME word-boundary logic as strain search (A2), so "gas"
// only matches the word "gas", never inside "gasoline", etc.

import { containsWholeWord } from "./strainSearch.js";
import { loadDataFile } from "./dataFile.js";

let dabCache = null;
let slangCache = null;

function loadDabs() {
  if (dabCache) return dabCache;
  dabCache = loadDataFile("dabs_knowledge.json");
  return dabCache;
}

function loadSlang() {
  if (slangCache) return slangCache;
  slangCache = loadDataFile("slang_dictionary.json");
  return slangCache;
}

// Slang is only injected when the user seems to be asking ABOUT a term
// (origin / meaning), so common words like "weed" or "bud" don't spam an
// etymology block onto every message.
const ORIGIN_CUE =
  /\b(where|origin|originate|comes?\s+from|came\s+from|etymolog\w*|mean|means|meaning|named?\s+after|stand\s+for|stands\s+for|history\s+of|what\s+is|what'?s|why\s+(?:is\s+)?(?:it|they|that)?\s*called)\b/i;

function tokenSet(message) {
  return new Set(String(message || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Scan a plant-tab message for dab terms and (on an origin/meaning question)
 * slang terms. Word-boundary matched. Returns { dabs, slang } (each capped).
 */
export function lookupExtras(message) {
  if (!message || typeof message !== "string") return { dabs: [], slang: [] };
  const tokens = tokenSet(message);

  // Dabs: match the full name on word boundaries, or the slug as a whole token
  // (catches single-word shorthands like "diamonds", "shatter").
  const dabs = loadDabs()
    .filter((d) => containsWholeWord(message, d.name) || tokens.has(String(d.slug).toLowerCase()))
    .slice(0, 2);

  // Slang: only on an origin/meaning question, to avoid noise.
  let slang = [];
  if (ORIGIN_CUE.test(message)) {
    slang = loadSlang()
      .filter((s) => containsWholeWord(message, s.term) || tokens.has(String(s.slug).toLowerCase()))
      // Prefer the most specific (longest) term match.
      .sort((a, b) => b.term.length - a.term.length)
      .slice(0, 2);
  }

  return { dabs, slang };
}

/**
 * Build a short system-prompt injection block from lookupExtras results.
 * Returns "" when there's nothing to inject.
 */
export function formatExtrasBlock(matches) {
  if (!matches) return "";
  const { dabs = [], slang = [] } = matches;
  if (dabs.length === 0 && slang.length === 0) return "";

  let block = "";

  if (dabs.length > 0) {
    const lines = dabs.map((d) => {
      const prized = Array.isArray(d.prized_for) ? d.prized_for.join(", ") : "";
      return (
        `- ${d.name} (${d.extraction_method}, ${d.consistency}): ` +
        `${d.how_it_smokes} Temp: ${d.temp_range_f}.` +
        (prized ? ` Prized for: ${prized}.` : "")
      );
    });
    block +=
      `\n\n[CONCENTRATE FACTS — accurate reference; describe these from the facts here, don't guess]\n` +
      lines.join("\n");
  }

  if (slang.length > 0) {
    const lines = slang.map((s) => {
      const conf = String(s.origin_confidence || "unknown").toLowerCase();
      const rule =
        conf === "documented"
          ? "confidence: documented — you can tell this origin as fact."
          : `confidence: ${conf} — DO NOT state this as fact; hedge it ("the story goes...", "supposedly...", "nobody really agrees, but..."). Never assert a confident origin.`;
      return `- "${s.term}": ${s.origin}\n  ${rule}`;
    });
    block +=
      `\n\n[SLANG ORIGIN — honesty matters; obey the confidence flag on each]\n` +
      lines.join("\n");
  }

  return block;
}
