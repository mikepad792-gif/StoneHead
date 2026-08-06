// lib/safetyCard.js
// The resource card (Addendum B1).
//
// WHERE THE GUARANTEE LIVES NOW
// Fixed text was unsteerable because no model generated it. A card is
// unsteerable because it is attached IN CODE, after the model returns. No
// prompt injection talks a UI component off a screen. That property was always
// the point; the canned paragraph was just how it was being bought — and it
// was bought at the price of seven identical replies in a row.
//
// So the load-bearing FACTS live here, not in the prose. Anything a person
// needs to be true regardless of what the model decided to say — the numbers,
// the Good Samaritan line, "safe even if you're wrong" — belongs in this file.
// The prose carries the conversation; the card carries the guarantee.

import {
  CRISIS_LINE,
  EMERGENCY_LINE,
  NEVER_USE_ALONE,
  NALOXONE_BY_MAIL,
  NALOXONE_LOCATOR,
} from "./safetyResources.js";

/**
 * Attribution. Modeled on the pattern in Claude's own interface.
 *
 * This does real work: it tells someone in that moment exactly what they're
 * looking at and who is behind it, and it matches what the Terms of Service
 * already say — that StoneHead is not a crisis service and nobody is watching.
 */
const CRISIS_ATTRIBUTION =
  "Support provided by the 988 Suicide & Crisis Lifeline, not StoneHead.";
const SUBSTANCE_ATTRIBUTION =
  "Support provided by emergency services, Never Use Alone, and NEXT Distro — not StoneHead.";

const CARDS = {
  crisis: {
    type: "crisis",
    title: "If you need someone right now",
    attribution: CRISIS_ATTRIBUTION,
    resources: [
      {
        label: "988 Suicide & Crisis Lifeline",
        value: CRISIS_LINE,
        detail: "Call or text, any hour. Real people.",
        href: `tel:${CRISIS_LINE}`,
      },
    ],
  },
  substance: {
    type: "substance",
    title: "If something's wrong right now",
    attribution: SUBSTANCE_ATTRIBUTION,
    resources: [
      {
        label: "Emergency services",
        value: EMERGENCY_LINE,
        // The sentence doing the most work in the whole card. Fear of arrest
        // is why the call doesn't get made.
        detail:
          "Say you used something and feel wrong — that's the whole call. " +
          "Good Samaritan laws protect you for calling in almost every state.",
        href: `tel:${EMERGENCY_LINE}`,
      },
      {
        label: "Never Use Alone",
        value: NEVER_USE_ALONE,
        detail:
          "Free, 24/7. They stay on the line and send help if you stop answering. " +
          "The people picking up have used too.",
        href: `tel:${NEVER_USE_ALONE.replace(/-/g, "")}`,
      },
      {
        label: "Naloxone (Narcan)",
        value: "Any pharmacy, over the counter",
        detail:
          "Reverses an opioid overdose, and it's safe to use even if you're wrong " +
          "about what's happening.",
        href: NALOXONE_BY_MAIL,
        hrefLabel: "Free by mail",
        secondaryHref: NALOXONE_LOCATOR,
        secondaryLabel: "Free pickup sites",
      },
    ],
  },
};

/**
 * Build the card for a turn, or null.
 *
 * @param {"crisis"|"substance"|null} kind
 * @returns {object|null}
 */
export function buildSafetyCard(kind) {
  if (!kind || !CARDS[kind]) return null;
  // Fresh copy per response — callers must never mutate the template.
  return JSON.parse(JSON.stringify(CARDS[kind]));
}

/**
 * FALLBACK (B1). If the client doesn't understand `safetyCard` — an old cached
 * bundle, a failed render — the backend appends the resource to the text
 * instead.
 *
 * A frontend deploy failure must not silently remove the disclosure. That is
 * the whole reason this function exists: the card is the better experience,
 * but the disclosure is not allowed to depend on the better experience
 * shipping correctly.
 *
 * @param {string} text  the model's reply
 * @param {"crisis"|"substance"|null} kind
 * @returns {string}
 */
export function appendCardFallback(text, kind) {
  const card = CARDS[kind];
  if (!card) return text;

  const lines = card.resources.map((r) => `${r.label}: ${r.value}`);
  return (
    `${text}\n\n— — —\n${lines.join("\n")}\n${card.attribution}`
  );
}
