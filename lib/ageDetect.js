// lib/ageDetect.js
// StoneHead — age self-identification detector (safety layer)
//
// Pure, no I/O, no model call. Runs before the model call, same position as
// detectCrisis and detectSubstance.
//
// SELF-IDENTIFICATION ONLY. If the user never says anything about their age,
// NOTHING HAPPENS. There is no inference, no guessing from writing style, no
// age estimation from vocabulary or topic. That would be both unreliable and
// creepy, and getting it wrong in either direction is worse than not doing it.
//
// WHY THIS EXISTS
// Probe A1 failed identically twice, on Aug 2 and Aug 3. A user said they were
// fourteen on turn 1; on turn 3 StoneHead described what being high feels like.
// Nothing carried the state forward — the same structural bug as the crisis
// intercept, one layer over.
//
// The DETECTION here is the easy half. The half that actually fixes A1 is
// persistence on the USER record (migration 010), because a 14-year-old who
// opens a new thread is still fourteen.

const NUMBER_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  "twenty one": 21, twentyone: 21, "twenty-one": 21,
};

/**
 * Units that turn a bare number into something that is not an age.
 * "I'm 14 hours into this grow" is the addendum's first false positive, and
 * it is a completely ordinary sentence on the plant tab.
 */
const UNIT_WORDS = [
  "hour", "hours", "hr", "hrs", "minute", "minutes", "min", "mins",
  "day", "days", "week", "weeks", "month", "months", "year", "years",
  "grams", "gram", "g", "oz", "ounce", "ounces", "pound", "pounds", "lb", "lbs",
  "percent", "%", "degrees", "inches", "inch", "feet", "ft", "cm", "ml", "mg",
  "plants", "plant", "seeds", "seed", "bucks", "dollars", "miles", "mile",
  "gallons", "gallon", "liters", "watt", "watts", "strains", "people",
];

/**
 * Phrases that make the number about SOMEBODY ELSE, or about the past.
 * "my kid is 14" and "when I was 14 I thought that too" are both the addendum's
 * named false positives, and both are things a parent or an adult says in a
 * completely legitimate conversation.
 */
const THIRD_PARTY_MARKERS = [
  "my kid", "my son", "my daughter", "my nephew", "my niece", "my brother",
  "my sister", "my cousin", "my friend", "my student", "my grandson",
  "my granddaughter", "his", "her", "their", "he is", "hes", "she is", "shes",
  "they are", "theyre",
];

const PAST_TENSE_MARKERS = [
  "when i was", "back when", "i used to be", "at that age", "i was",
];

/**
 * Adult roles that put the speaker AT a school rather than IN one.
 * "I teach high school" is a 40-year-old talking about their job, and flagging
 * them as a minor would quietly close the plant tab on a legitimate user with
 * no way for them to work out why.
 */
const ADULT_ROLE_MARKERS = [
  "i teach", "i taught", "i work at", "i work in", "i coach", "my students",
  "my class", "i drive bus", "im a teacher", "im a coach", "im a counselor",
  "i substitute", "my classroom",
];

/** Grade-level and school-stage signals. These are age statements too. */
const SCHOOL_GRADES = [
  { re: /\b(\d{1,2})(st|nd|rd|th)\s+grade\b/, grade: (m) => Number(m[1]) },
  { re: /\bgrade\s+(\d{1,2})\b/, grade: (m) => Number(m[1]) },
];

// US school stages -> the OLDEST plausible age, so the band we pick is the
// most permissive one consistent with the statement. A high school senior is
// usually 17 or 18; taking 18 avoids flagging an adult as a minor on a word
// that genuinely spans the boundary.
const SCHOOL_STAGES = [
  { cue: "middle school", age: 13 },
  { cue: "jr high", age: 13 },
  { cue: "junior high", age: 13 },
  { cue: "high school", age: 17 },
  { cue: "highschool", age: 17 },
  { cue: "freshman", age: 14 },
  { cue: "sophomore", age: 15 },
];

/**
 * WEAK signals. Named in the addendum and deliberately NOT wired to fire on
 * their own — "my parents won't let me" is something a 30-year-old says about
 * a family holiday, and "I have school tomorrow" is something a teacher says.
 * Kept here as documentation of a decision rather than as live logic.
 */
export const WEAK_SIGNALS_NOT_USED = [
  "my mom wont let me", "my dad wont let me", "my parents wont let me",
  "before my parents get home", "i have school tomorrow",
];

function normalize(s) {
  return String(s || "").toLowerCase().replace(/['’`]/g, "");
}

/** Band for a stated age, or null if the age is 21+. */
export function bandForAge(age) {
  if (!Number.isFinite(age) || age < 0 || age > 120) return null;
  if (age < 13) return "under_13";
  if (age < 18) return "minor";
  if (age < 21) return "under_21";
  return null;
}

/**
 * Is this number followed by a unit? "14 hours", "14 grams", "14%".
 * Checked on the ORIGINAL text so the unit's position is meaningful.
 */
function followedByUnit(text, matchEnd) {
  const tail = text.slice(matchEnd, matchEnd + 24).trim();
  if (!tail) return false;
  const nextWord = tail.split(/[^a-z0-9%]+/).filter(Boolean)[0];
  return nextWord ? UNIT_WORDS.includes(nextWord) : false;
}

/**
 * Word-boundary phrase match. NOT substring — "this" contains "his", "there"
 * contains "her", and "other" contains "the". A plain includes() here made
 * "I'm a freshman this year" read as somebody else's age.
 */
function hasAny(text, cues) {
  return cues.some((c) => {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(text);
  });
}

/**
 * Detect a first-person, present-tense age statement.
 *
 * @param {string} message
 * @returns {{ band: "under_13"|"minor"|"under_21"|null, stated: number|null, signal: string|null }}
 *   band is null when nothing fired OR when the stated age is 21+. A 21+
 *   statement is not stored — there is nothing to constrain.
 */
export function detectAge(message) {
  const text = normalize(message);
  const none = { band: null, stated: null, signal: null };
  if (!text) return none;

  // Somebody else's age, or a past-tense one, is not this user's age.
  // Checked before anything else so "my kid is 14" can never reach the
  // number patterns below.
  if (hasAny(text, THIRD_PARTY_MARKERS) || hasAny(text, PAST_TENSE_MARKERS)) {
    return none;
  }

  // ── First person + number ────────────────────────────────────────
  // "i'm 14", "im 14", "i am 14", "just turned 14", "about to be 14",
  // "14 years old". The subject has to be the speaker and the tense present.
  const numberPatterns = [
    /\bi\s*m\s+(\d{1,3})\b/,
    /\bi\s+am\s+(\d{1,3})\b/,
    /\bjust\s+turned\s+(\d{1,3})\b/,
    /\babout\s+to\s+be\s+(\d{1,3})\b/,
    /\bturning\s+(\d{1,3})\b/,
    /\b(\d{1,3})\s+(?:years|yrs|yr)\s+old\b/,
  ];

  for (const re of numberPatterns) {
    const m = text.match(re);
    if (!m) continue;
    // "I'm 14 hours into this grow" — the unit disqualifies it.
    if (followedByUnit(text, m.index + m[0].length)) continue;
    const age = Number(m[1]);
    const band = bandForAge(age);
    if (band) return { band, stated: age, signal: m[0].trim() };
    // A stated 21+ age is a real statement; it just needs no flag.
    return none;
  }

  // ── Spelled-out numbers ──────────────────────────────────────────
  for (const [word, age] of Object.entries(NUMBER_WORDS)) {
    const re = new RegExp(
      `\\b(?:i\\s*m|i\\s+am|just\\s+turned|about\\s+to\\s+be|turning)\\s+${word}\\b`
    );
    if (re.test(text)) {
      const band = bandForAge(age);
      return band ? { band, stated: age, signal: word } : none;
    }
    if (new RegExp(`\\b${word}\\s+(?:years|yrs)\\s+old\\b`).test(text)) {
      const band = bandForAge(age);
      return band ? { band, stated: age, signal: `${word} years old` } : none;
    }
  }

  // ── Grade level ──────────────────────────────────────────────────
  // US grade N maps to roughly age N + 5. 9th grade -> 14.
  for (const { re, grade } of SCHOOL_GRADES) {
    const m = text.match(re);
    if (!m) continue;
    const g = grade(m);
    if (!Number.isFinite(g) || g < 1 || g > 12) continue;
    const band = bandForAge(g + 5);
    if (band) return { band, stated: null, signal: m[0].trim() };
  }

  // ── School stage ─────────────────────────────────────────────────
  // "senior" and "junior" are deliberately ABSENT: both are common job titles
  // ("senior engineer") and both appear in college contexts where the speaker
  // is an adult. The addendum lists them under school context, and there is no
  // reliable way to establish that context from one message.
  // "freshman"/"sophomore" are college words too, and a college freshman is
  // usually 18. If college is anywhere in the message, the stage cues stop
  // being an age claim.
  const collegeContext = /\b(?:college|university|uni|campus|dorm)\b/.test(text);
  const adultRole = hasAny(text, ADULT_ROLE_MARKERS);

  for (const { cue, age } of SCHOOL_STAGES) {
    if (!text.includes(cue)) continue;
    if (collegeContext || adultRole) continue;
    // "my high school teacher", "the high school down the road" — a place or
    // a person, not a claim about the speaker. Note "a" is deliberately NOT
    // in this list: "I'm a freshman" is exactly the claim we want.
    if (new RegExp(`\\b(?:my|the|his|her|their)\\s+${cue}`).test(text)) continue;
    const band = bandForAge(age);
    if (band) return { band, stated: null, signal: cue };
  }

  return none;
}

/**
 * Bands that block the plant tab and every experiential description.
 * under_21 is included: they are an adult, but not for cannabis.
 */
export function blocksCannabis(band) {
  return band === "under_13" || band === "minor" || band === "under_21";
}

/** Bands below the ToS floor entirely. */
export function belowFloor(band) {
  return band === "under_13";
}

/**
 * Reply for a user who states an age below the ToS floor of 13.
 *
 * FIXED TEXT, no model call — same reasoning as CRISIS_REPLY. Kind, plain, and
 * it stops. The policy already promises "if I learn that someone under 13 has
 * created an account, I'll delete it"; this is the thing that makes the
 * promise reachable, by logging it for action.
 */
export const UNDER_13_REPLY = `Hey — I've gotta be straight with you. This app isn't built for anyone under 13, so I can't keep going here. That's not me judging you, it's just the line I've got.

I hope you find good people to talk to. Seriously. Take care of yourself.`;
