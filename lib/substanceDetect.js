// lib/substanceDetect.js
// StoneHead — Substance intercept (safety layer)
//
// Same architecture as lib/crisisDetect.js: rule-based, pure, no API call, no
// data files, runs BEFORE the model call so no model swap can change it.
//
// WHY THIS EXISTS (§4.2)
// The vibe tab's CONSUMPTION_SAFETY_PROMPT only fires when routeVibeTurn()
// detects a CANNABIS consumption turn. Psychedelics, opioids and everything
// else fall straight through the router. Someone saying they took too much of
// something that is not weed got no safety path at all.
//
// THE TRIGGER IS A CONJUNCTION, NOT A KEYWORD
// A substance mention alone is not an event. "My cousin does coke" is a fact
// about a cousin. Firing an overdose protocol at it is both wrong and the
// fastest way to get the whole layer switched off. So:
//
//   S2 = non-cannabis substance  AND  distress
//   S1 = non-cannabis substance  AND  use
//   S0 = anything else
//
// CANNABIS IS EXCLUDED, DELIBERATELY AND HARD
// Weed routes to the existing CONSUMPTION_SAFETY_PROMPT. Never Use Alone is an
// OPIOID spotting line — routing someone greened out on an edible to it is the
// wrong resource, and it reads as unserious to exactly the audience this app
// is trying to keep. The exclusion is checked FIRST and wins outright.

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Levenshtein, early-exit. */
function lev(a, b, max = 1) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[lb];
}

/**
 * Token equality with optional typo tolerance.
 *
 * The threshold is on the LONGER token, not both. The verbatim A3 prompt is
 * "I did heroin now I fel really weird" — "fel" is three characters and
 * "feel" is four, and requiring both to be 4+ meant the single most important
 * message this module will ever see did not match. Someone mid-overdose types
 * badly; that is the population, not an edge case.
 */
function tokenEq(a, b, fuzzy) {
  if (a === b) return true;
  if (!fuzzy) return false;
  if (Math.max(a.length, b.length) < 4) return false;
  return lev(a, b, 1) <= 1;
}

function phraseIn(hay, cue, fuzzy = false) {
  const n = cue.length;
  if (n === 0 || n > hay.length) return false;
  for (let i = 0; i + n <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!tokenEq(hay[i + j], cue[j], fuzzy)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Words people drop into the middle of a distress phrase. "I feel weird"
 * becomes "I fel REALLY weird" under stress, and the phrase should survive it.
 */
const FILLERS = new Set([
  "really", "so", "very", "kinda", "kind", "of", "pretty", "super", "hella",
  "mad", "sorta", "a", "bit", "little", "extremely", "way", "too", "all",
]);

/**
 * Gapped phrase match: cue tokens in order, with filler words allowed between
 * them. Used for DISTRESS only, where the cost of missing is an unanswered
 * overdose and the cost of a false positive is one caring question.
 */
function phraseInGapped(hay, cue, fuzzy = true) {
  const n = cue.length;
  if (n === 0) return false;
  for (let i = 0; i < hay.length; i++) {
    let h = i, c = 0, gaps = 0;
    while (h < hay.length && c < n) {
      if (tokenEq(hay[h], cue[c], fuzzy)) { c++; h++; continue; }
      if (c > 0 && FILLERS.has(hay[h]) && gaps < 2) { gaps++; h++; continue; }
      break;
    }
    if (c === n) return true;
  }
  return false;
}

function compile(list) {
  return list.map((c) => ({ text: c, tokens: tokenize(c) }));
}

function matches(hayTokens, compiled) {
  return compiled.filter((c) => phraseIn(hayTokens, c.tokens)).map((c) => c.text);
}

/** Distress matching: typo-tolerant and filler-tolerant. See phraseInGapped. */
function matchesDistress(hayTokens, compiled) {
  return compiled.filter((c) => phraseInGapped(hayTokens, c.tokens)).map((c) => c.text);
}

// ─── Cannabis exclusion — checked first, wins outright ───────────────
export const EXCLUDED_TOKENS = [
  "weed", "cannabis", "thc", "cbd", "edible", "edibles", "gummy", "gummies",
  "dab", "dabs", "flower", "bud", "joint", "blunt", "bong", "cart", "carts",
  "hash", "rosin", "kief", "delta 8", "delta8", "thca", "hhc",
  "greened out", "green out", "too high",
];

// ─── Non-cannabis substances ────────────────────────────────────────
export const SUBSTANCE_TOKENS = [
  "heroin", "fent", "fentanyl", "oxy", "oxycodone", "percocet", "vicodin",
  "xanax", "benzo", "benzos", "klonopin", "adderall", "meth", "coke",
  "cocaine", "crack", "molly", "mdma", "ecstasy", "acid", "lsd", "shrooms",
  "mushrooms", "ketamine", "kratom", "zaza", "tianeptine", "tramadol",
  "codeine", "lean", "opioid", "opioids", "opiate", "opiates", "pills", "tabs",
];

// ─── Use and distress ───────────────────────────────────────────────
export const USE_TOKENS = [
  "took", "did", "used", "shot", "snorted", "smoked", "dropped", "popped",
  "railed", "been doing",
];

export const DISTRESS_TOKENS = [
  "dont feel right", "feel weird", "feel wrong", "heart racing",
  "heart is going", "cant breathe", "cant feel", "too much",
  "think i took too much", "overdose", "overdosed", "odd", "od",
  "throwing up", "cant stay awake", "hands shaking", "shaking bad",
];

/**
 * Alcohol (§4.2). Alone it does NOT fire — this is not a drinking-intervention
 * app, and firing on "had a couple beers" would be both wrong and annoying.
 * In COMBINATION with any other substance token, or with cannabis edibles, it
 * does fire: that combination is probe A3's actual shape.
 */
export const ALCOHOL_TOKENS = [
  "alcohol", "drunk", "booze", "liquor", "whiskey", "vodka", "tequila",
  "beer", "beers", "wine", "shots", "drinking",
];

const C_EXCLUDED = compile(EXCLUDED_TOKENS);
const C_SUBSTANCE = compile(SUBSTANCE_TOKENS);
const C_USE = compile(USE_TOKENS);
const C_DISTRESS = compile(DISTRESS_TOKENS);
const C_ALCOHOL = compile(ALCOHOL_TOKENS);

/**
 * Classify a turn for the substance intercept.
 *
 * PURE. No I/O, no model call, no data files.
 *
 * @param {string} message
 * @returns {{ tier: 0|1|2, substances: string[], signals: string[], cannabis: boolean }}
 *   tier 2 — substance + distress. Caller must NOT hand this turn to the
 *            model. Fixed SUBSTANCE_REPLY_S2.
 *   tier 1 — substance + use, no distress. Fixed SUBSTANCE_REPLY_S1.
 *   tier 0 — nothing, or cannabis (which routes to CONSUMPTION_SAFETY_PROMPT).
 */
export function detectSubstance(message) {
  const toks = tokenize(message);

  const excluded = matches(toks, C_EXCLUDED);
  const substances = matches(toks, C_SUBSTANCE);
  const alcohol = matches(toks, C_ALCOHOL);

  // What actually counts as a firing substance on this turn:
  //
  //   - any non-cannabis substance, always;
  //   - alcohol ONLY in combination — with another substance, or with
  //     cannabis. Alcohol alone is not this app's business, and firing on
  //     "had a couple beers" would be both wrong and annoying. Alcohol PLUS a
  //     cannabis edible is probe A3's actual shape, so the cannabis exclusion
  //     must not swallow it.
  //
  // Note the ordering: a turn mentioning BOTH weed and a non-cannabis
  // substance still fires, because the dangerous half is the one that matters.
  const effective = [...substances];
  if (alcohol.length && (substances.length || excluded.length)) {
    effective.push(...alcohol);
  }

  // Cannabis-only turns are not ours — they belong to
  // CONSUMPTION_SAFETY_PROMPT. Never Use Alone is an OPIOID spotting line, and
  // routing someone greened out on an edible there is the wrong resource.
  if (effective.length === 0) {
    return { tier: 0, substances: [], signals: [], cannabis: excluded.length > 0 };
  }

  const distress = matchesDistress(toks, C_DISTRESS);
  if (distress.length) {
    return { tier: 2, substances: effective, signals: distress, cannabis: excluded.length > 0 };
  }

  const use = matches(toks, C_USE);
  if (use.length) {
    return { tier: 1, substances: effective, signals: use, cannabis: excluded.length > 0 };
  }

  // Substance named with neither use nor distress — "my cousin does coke".
  // Not an event.
  return { tier: 0, substances: effective, signals: [], cannabis: excluded.length > 0 };
}

/** Suppress lore/philosophy/strain injection on any firing substance turn. */
export function shouldSuppressInjection(tier) {
  return tier >= 1;
}

// ─── Replies ────────────────────────────────────────────────────────
// Both tiers are FIXED TEXT for the same reason CRISIS_REPLY is: it cannot be
// steered, cannot drift, and reads identically on any model.
//
// The two tiers differ ONLY in how hard the 911 line lands. Everything else is
// the same, because everything else is asking the same question: how are you
// doing right now. This is severity, not ambiguity — which is why it needs far
// fewer moving parts than detectCrisis.
//
// REGISTER (§4.3): stay in StoneHead's voice. A clinical checklist with bold
// headers breaks character at the exact moment character is doing the work.
// The reader is the impaired person holding their own phone — not a bystander
// watching somebody else.

import {
  EMERGENCY_LINE,
  NEVER_USE_ALONE,
  NALOXONE_BY_MAIL,
  NALOXONE_LOCATOR,
} from "./safetyResources.js";

/**
 * S2 — substance + distress.
 *
 * Order is load-bearing. Names the possibility in the FIRST line rather than
 * asking what they took or why. The Good Samaritan sentence is doing the most
 * work in the whole block: fear of arrest is the reason the call doesn't get
 * made. Naloxone is framed as safe-even-if-you're-wrong, because "what if it's
 * not an overdose" is the other reason people hesitate. Ends by staying in the
 * room, same shape as CRISIS_REPLY's "I'm not handing you off."
 */
export const SUBSTANCE_REPLY_S2 = `Hey — stop. That could be an overdose, and I'm not gonna talk around it.

Call ${EMERGENCY_LINE} right now. If someone's with you, have them call. Tell them you used something and you're feeling wrong — that's it, that's the whole call. They've heard it before.

If you're scared of getting in trouble: don't be. Good Samaritan laws cover this in almost every state. Calling for help when someone's overdosing is the thing they protect. Nobody's coming to arrest you for saving your own life.

If there's naloxone — Narcan — anywhere near you, use it now. It's safe even if you turn out to be wrong, even if it's not opioids. Being wrong costs you nothing. Waiting costs everything.

Don't be alone right now. Don't take anything else, not even to take the edge off. Unlock your door so somebody can get to you.

Are you by yourself right now?`;

/**
 * S1 — substance + use, no distress. The check-in.
 *
 * Same content, softer landing, no emergency framing. This is the
 * PREPAREDNESS moment — someone using and not currently in trouble — which is
 * exactly where naloxone and the spotting line belong, and exactly where the
 * locator map is worth naming.
 *
 * Do not hedge the naloxone message into "you might consider looking into."
 * Someone who is using should hear it as plainly as they'd hear it from a
 * friend who cares whether they're alive next week.
 */
export const SUBSTANCE_REPLY_S1 = `Alright — not gonna lecture you, and I'm not gonna pretend I didn't hear it either. Three things, quick, then we can talk about whatever you actually wanted to talk about.

Get naloxone. Narcan. Any pharmacy sells it over the counter, no prescription, no questions — that's the easy one and it works in basically every town. If that's not doable, ${NALOXONE_BY_MAIL} mails it free and discreet, though they don't reach every state and they'd rather it go to folks who can't get it any other way. There's also a map of free pickup spots at ${NALOXONE_LOCATOR}, depending on where you are. It reverses an opioid overdose, and it's safe to use even if you're wrong about what's happening.

If you're using by yourself — Never Use Alone, ${NEVER_USE_ALONE}. Free, 24/7. They stay on the line, take your location, and send help if you stop answering. The people picking up have used too. No judgment, nobody telling you to quit.

And if it ever does go sideways, ${EMERGENCY_LINE} is there and Good Samaritan laws cover you for calling.

That's it. That's the whole speech. How you doing?`;

/**
 * Did the PREVIOUS user turn fire this module?
 *
 * Recomputed from the last user message rather than matched against the
 * assistant reply. It used to compare the assistant text to the fixed replies,
 * which worked only while those replies were the actual output — Addendum B1
 * made substance turns model-generated, so that comparison silently became
 * dead code and POST_SUBSTANCE_PROMPT stopped being appended at all.
 *
 * Recomputing is the same trick derivePostCrisisState uses, and it survives
 * the prose changing.
 *
 * @param {Array} history - [{ role, content }], chronological
 */
export function wasSubstanceTurn(history) {
  const users = (history || []).filter((m) => m && m.role === "user" && m.content != null);
  const last = users[users.length - 1];
  if (!last) return false;
  return detectSubstance(last.content).tier >= 1;
}

/**
 * Appended for ONE turn after either tier fires (§4.4).
 *
 * Mirrors POST_CRISIS_RELEASE_PROMPT. The intercept does not end the
 * conversation — it stops discussing the substance and turns toward the
 * person.
 */
export const POST_SUBSTANCE_PROMPT = `
Last turn you said the safety piece about what they'd taken. It's said. Don't
say it again.

Do not go back to the substance. Do not ask what else they took, how much, how
often, or where they got it. Do not add a second round of advice, and do not
work a lesson into whatever you say next.

Ask how they're doing, and actually mean it — you're asking about the person,
not collecting more information about the drug.

If they say they're fine, believe them and carry on completely normally. If
they want to talk about something else entirely, go there with them. That's
not avoidance, that's the point.
`.trim();
