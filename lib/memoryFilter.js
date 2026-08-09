// lib/memoryFilter.js
// StoneHead — What memory is NOT allowed to keep (Addendum C1 part 1, C5)
//
// THE BUG THIS EXISTS FOR
// A stored session memory said the user was 14 and struggling with school.
// Memories are injected into the system prompt on every turn, including crisis
// turns, so the model kept reaching for it: "Being a teenager is hard," "You're
// 14, right?", "especially at your age." Two rounds of tightening the
// do-not-announce wording in prompts/minor.js changed nothing, because the
// prompt was never the source. The memory was.
//
// THE PRINCIPLE
// self_reported_age_band is structured data. Code can read it, gate on it, and
// reason about it. The same fact sitting in a memory blob is ungoverned — no
// gate can see it, and every prompt that tries to suppress it is arguing with
// the memory feature's entire purpose, which is to reference what it remembers.
// Duplicating a governed fact into an ungoverned one IS the bug. So: don't
// write it.
//
// SCOPE (the decision C5 asked for)
// Excluded on write:
//   1. Ages, birth dates, grade levels          — required by C1
//   2. Health conditions, diagnoses, medications — the startle test
//   3. Turns adjacent to a safety turn           — the blast radius of §4
//
// The test in C5 is whether a person would be startled to see it rendered back
// at them three weeks later in a casual conversation. A diagnosis and a
// prescription both fail that test as hard as an age does, and neither is
// something the app needs to remember to be good company. The cost of being
// wrong in this direction is a slightly thinner memory. The cost of being
// wrong in the other direction is the C1 failure with a different noun.
//
// HOW IT FAILS: closed. A summary that trips any rule is DROPPED, not redacted.
// Redaction leaves a sentence with a hole in it that the model will happily
// fill, and a partial memory of a medical fact is still a memory of it.

// ─── Age, birth date, grade level ───────────────────────────────────
//
// These run against MODEL-GENERATED SUMMARY PROSE, not raw user text, which
// is why they can be this direct: the summarizer writes "they are 14" and
// "a 14-year-old", not "im 14 lol". Raw-message detection is ageDetect.js's
// job and it stays there.
const AGE_PATTERNS = [
  /\b\d{1,2}\s*(?:-|\s)?\s*years?\s*(?:-|\s)?\s*old\b/i,
  /\b\d{1,2}\s*(?:-|\s)?\s*year\s*(?:-|\s)?\s*old\b/i,
  /\b(?:is|are|they'?re|he'?s|she'?s|user is|person is|turning|turned|aged)\s+\d{1,2}\b/i,
  /\bage(?:d)?\s+(?:of\s+)?\d{1,2}\b/i,
  /\btheir age\b/i,
  /\bborn in\s+(?:19|20)\d{2}\b/i,
  /\bdate of birth\b|\bbirth ?day\b|\bd\.?o\.?b\.?\b/i,
  /\b(?:in|the)\s+\d{1,2}(?:st|nd|rd|th)\s+grade\b/i,
  /\b(?:freshman|sophomore|junior|senior)\b/i,
  /\bhigh ?school(?:er)?\b|\bmiddle ?school(?:er)?\b|\bjunior high\b/i,
  /\bminor\b|\bunderage\b|\bteenager\b|\bteenaged\b|\bteen\b/i,
];

// ─── Health conditions, diagnoses, medications ──────────────────────
//
// Deliberately a condition/medication VOCABULARY rather than a "sounds
// medical" heuristic. A vocabulary is auditable and its false positives are
// visible in this list; a heuristic's are not. Missing a rare condition costs
// one memory that should not have been written — the purge script exists for
// exactly that, and this list is meant to grow.
const HEALTH_PATTERNS = [
  // Diagnosis framing — catches conditions this list has never heard of.
  /\bdiagnos(?:ed|is|es)\b/i,
  /\bwas told (?:they|he|she|the user) (?:has|had)\b/i,
  /\bin (?:therapy|treatment|rehab|recovery)\b/i,
  // Bare mental-health providers: "sees a therapist" is the whole fact and it
  // does not need a possessive to be one. `doctor` and `physician` stay behind
  // a possessive because "their brother is a doctor" is somebody's job, not
  // somebody's healthcare.
  /\b(?:therapist|psychiatrist|psychologist)\b/i,
  /\b(?:their|his|her|the) (?:doctor|physician)\b/i,
  // Named conditions.
  /\b(?:depression|depressive|anxiety disorder|bipolar|schizophreni|psychosis|psychotic|ptsd|c-?ptsd|ocd|adhd|add|autis|asperger)\w*/i,
  /\b(?:epilep|diabet|asthma|cancer|leukemia|lupus|crohn|colitis|fibromyalgia|endometriosis|hiv|aids|hepatitis)\w*/i,
  /\b(?:eating disorder|anorexi|bulimi|self-?harm|cutting)\w*/i,
  /\bchronic (?:pain|illness|fatigue)\b/i,
  // Medication framing + the classes most likely to show up here.
  /\b(?:prescribed|prescription|medicated|on medication|off (?:their|his|her) meds)\b/i,
  /\b(?:antidepressant|antipsychotic|benzodiazepine|benzo|ssri|snri|mood stabilizer)\w*/i,
  /\b(?:zoloft|prozac|lexapro|celexa|paxil|wellbutrin|effexor|cymbalta|trazodone|lithium|abilify|seroquel|risperdal|lamictal|adderall|ritalin|vyvanse|concerta|xanax|ativan|klonopin|valium|gabapentin|suboxone|methadone|naltrexone)\b/i,
];

/**
 * Why a memory must not be written, or [] if it may be.
 * Returns reason slugs so callers can log WHICH rule fired — a filter whose
 * rejections are invisible cannot be tuned.
 *
 * @param {string} text
 * @returns {string[]} e.g. ["age"], ["health"], ["age","health"]
 */
export function memoryExclusionReasons(text) {
  const s = String(text || "");
  if (!s.trim()) return [];
  const reasons = [];
  if (AGE_PATTERNS.some((re) => re.test(s))) reasons.push("age");
  if (HEALTH_PATTERNS.some((re) => re.test(s))) reasons.push("health");
  return reasons;
}

/** Convenience predicate. True when this text must never become a memory. */
export function isExcludedFromMemory(text) {
  return memoryExclusionReasons(text).length > 0;
}

// ─── The instruction half ───────────────────────────────────────────
//
// Defense in depth, and it is the WEAKER of the two halves on purpose. This
// asks the summarizer not to write the fact; memoryExclusionReasons() enforces
// it when the ask doesn't land. Same shape as the resource card: the prompt
// makes the good outcome likely, the code makes the bad outcome impossible.
export const MEMORY_EXCLUSION_NOTE =
  "NEVER include: anyone's age, birth date, year of birth, grade level, or " +
  "school year. NEVER include health conditions, diagnoses, mental-health " +
  "history, or medications. If the session was mostly about one of those, " +
  'return {"summary": "", "frame_tag": "routine"} rather than working around ' +
  "the rule. These are not judgment calls and there is no exception for a " +
  "detail that seems important.";

// ─── Safety adjacency ───────────────────────────────────────────────

/**
 * Drop safety turns and their immediate neighbours from a transcript before
 * it reaches the summarizer.
 *
 * chat-send already skips postwork ON a safety turn, so a crisis disclosure is
 * never itself summarized. What that misses is the turn on either side of it:
 * the message that led up to the disclosure and the one that came right after,
 * both of which are usually about the same thing, and both of which sit in the
 * transcript that a LATER ordinary turn summarizes.
 *
 * A ±1 window, not the whole thread. Dropping the thread would mean one hard
 * night erases a person's memory of every conversation they had that week,
 * which is its own kind of forgetting them.
 *
 * @param {Array<{role:string,content:string}>} transcript
 * @param {(text: string) => boolean} isSafetyTurn - injected so this module
 *        stays free of the detectors (and of their load cost in tests)
 * @returns {Array} filtered transcript, same objects, original order
 */
export function dropSafetyAdjacent(transcript, isSafetyTurn) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];
  if (typeof isSafetyTurn !== "function") return transcript.slice();

  const flagged = new Set();
  transcript.forEach((m, i) => {
    if (m && m.role === "user" && isSafetyTurn(m.content)) {
      flagged.add(i - 1);
      flagged.add(i);
      flagged.add(i + 1);
    }
  });
  if (flagged.size === 0) return transcript.slice();

  return transcript.filter((_, i) => !flagged.has(i));
}
