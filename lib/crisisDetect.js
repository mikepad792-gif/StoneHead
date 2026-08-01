// lib/crisisDetect.js
// StoneHead — Crisis intercept (safety layer)
//
// Rule-based, in-path, no API call, no added latency. Shaped like
// frameDetect.js on purpose: same hasAny() padding convention, same
// pure-function contract, same "no data-file dependency" property.
//
// WHY THIS EXISTS
// On July 13 a trusted member ran an adversarial probe: he fed StoneHead's
// own letting-go metaphors back to it, escalating toward self-harm framing.
// Every good save in that transcript came from the live model's own instinct.
// There was nothing underneath it. This is the something underneath it.
//
// THE STRUCTURAL PROBLEM THIS ADDRESSES
// StoneHead's therapeutic vocabulary — stop the story, make everything stop,
// be done inside, take yourself out, put it down — is genuinely ambiguous
// between dropping a grudge and ending a life. Combined with an
// affirm-then-clarify conversational habit, the dangerous half of the
// sentence lands first ("Yeah. I did say that. And I meant it.").
//
// DESIGN CONSTRAINTS
//   1. MODEL-AGNOSTIC. This runs BEFORE model selection and before the
//      model call. Swapping DeepSeek for Haiku, or any future model,
//      cannot change its behavior. Nothing here calls out.
//   2. TIER 2 IS HISTORY-INDEPENDENT. detectCrisis(msg) with no history
//      still returns every tier-2 hit. That property is what lets the
//      caller run the tier-2 check very early in the handler — in
//      particular, BEFORE the daily message limit.
//   3. FAILING DIRECTIONS ARE NOT SYMMETRIC. A false positive costs one
//      stiff moment in a conversation. A false negative costs everything
//      else. Cue lists lean permissive at tier 2 and conservative at
//      tier 1 (where the response stays conversational anyway).
//
// TIERS
//   2 — explicit. Self-harm stated, asked about, or named outright.
//       Caller must NOT hand this turn to the model at all.
//   1 — ambiguous. The letting-go vocabulary, in a context that suggests
//       it may be pointed at the person rather than at a grudge. Caller
//       hands this to the model but with the clarify-first instruction
//       and with lore/philosophy injection suppressed in code.
//   0 — nothing. Ordinary turn, untouched.

function hasAny(text, cues) {
  return cues.some((c) => text.includes(c));
}

function matches(text, cues) {
  return cues.filter((c) => text.includes(c));
}

function wordCount(message) {
  return String(message || "").trim().split(/\s+/).filter(Boolean).length;
}

// ─── Tier 2: explicit ───────────────────────────────────────────────
// Every entry is a PHRASE, never a bare word. "die" alone fires inside
// "I'd die for a burrito" and "dying laughing"; "hurt" fires inside
// "it hurt when they said that" — which is the entire vibe tab.
const EXPLICIT_CUES = [
  "kill myself", "killing myself", "end my life", "ending my life",
  "take my own life", "took my own life", "want to die", "wanna die",
  "want to be dead", "wish i was dead", "wish i were dead", "better off dead",
  "rather be dead", "don't want to be here", "dont want to be here",
  "don't wanna be here", "dont wanna be here", "not want to be here",
  "don't want to exist", "dont want to exist",
  "suicide", "suicidal", "end it all", "off myself", "offing myself",
  "unalive", "hurt myself", "hurting myself", "harm myself", "harming myself",
  "cut myself", "cutting myself", "overdose on purpose",
  "tell me to die", "telling me to die", "should i die", "want me to die",
  "no reason to live", "nothing to live for",
  "don't want to wake up", "dont want to wake up",
  // StoneHead-specific. "ending my story" was his own metaphor handed back
  // to him during the probe, and it is now a phrase this app taught people.
  "end my story", "ending my story", "end the story for good",
];

// ─── Tier 1: ambiguous ──────────────────────────────────────────────
// STRONG cues fire tier 1 on their own. Each is a self-directed totalizing
// phrase that is uncomfortable in any context, including a first message.
const AMBIGUOUS_STRONG = [
  "make everything stop", "make it all stop", "want it all to stop",
  "want everything to stop", "make it stop forever",
  "be done with everything",
  "take myself out", "taking myself out", "take me out of the equation",
  "take myself out of the equation", "taking myself out of the equation",
  "remove myself from the equation", "erase myself", "delete myself",
  "want to disappear", "wanna disappear",
  "stop existing", "stop being here",
];

// WEAK cues are ordinary English on their own — "I need to stop everything
// and take a break" is a normal sentence. They only reach tier 1 when the
// turn ALSO carries an echo signal (below), i.e. when the person is handing
// StoneHead's own words back to him.
// SHORT-STRONG cues need no echo, but only fire in a short message. These are
// phrases that are alarming when said bare and idiomatic when embedded:
// "I can't go on" is one thing; "I can't go on with this project the way it's
// structured" is a complaint about a project. The sentence's own continuation
// is what disambiguates it, so length is the discriminator, not context.
const AMBIGUOUS_SHORT_STRONG = [
  "can't go on", "cant go on", "can't do this anymore", "cant do this anymore",
  "can't keep going", "cant keep going", "i'm done", "im done",
  "want out", "i give up",
];

// A weak cue only fires in a SHORT message. This is the disambiguation rule:
// weak cues are ordinary English whose meaning is fixed by the words around
// them. "Like stop everything" (3 words) has no surrounding words, so the
// meaning is carried entirely by what StoneHead just said — that is an echo.
// "I need to stop everything and just breathe for a minute" (11 words) supplies
// its own context and means what it says. Tuned against the probe: the only
// weak-cue turn in it is 3 words long.
const WEAK_MAX_WORDS = 6;

const AMBIGUOUS_WEAK = [
  "stop everything", "done inside", "be done inside", "done with it all",
  "done with everything",
  "stop the story", "end the story", "the story stops",
  "put myself down", "give up on everything", "check out for good",
  "remove myself",
  "walk away from all of it", "let go of myself", "letting go of myself",
  "not be here", "not exist",
];

// ─── Echo signals ───────────────────────────────────────────────────
// The probe's signature was the person quoting StoneHead back at him. Three
// independent ways to notice that, any one of which counts.

// (a) Explicit attribution.
const ATTRIBUTION_CUES = [
  "you said", "you told me", "you just said", "like you said", "you meant",
  "that's what you said", "thats what you said", "you're saying", "youre saying",
  "you want me to", "according to you", "your words",
];

// (b) A quoted span in the message. In the probe: So I should just "take
//     myself out of the equation". Straight and curly quotes both count.
//     Requires 2+ words inside so a stray apostrophe can't trip it.
const QUOTED_SPAN_RE = /["“”](\s*\S+\s+\S+[^"“”]*)["“”]/;

// (c) StoneHead's own letting-go vocabulary appearing in a recent assistant
//     turn. This is the robust one — it works even when the person doesn't
//     use quotes or attribution, which is the likelier real-world case.
const ASSISTANT_LETTING_GO = [
  "let it go", "letting go", "let this go", "let something go",
  "put it down", "put the bag down", "put down a grudge",
  "stop the story", "the story stops", "story stops playing",
  "done inside", "done with this", "make everything stop",
  "stop being the person", "take yourself out", "walk away",
  "you don't have to keep", "you dont have to keep",
];

const ASSISTANT_LOOKBACK = 4;

/**
 * Detect a crisis or crisis-adjacent turn.
 *
 * PURE. No I/O, no model call, no data files. Safe to call as early in the
 * request handler as you like.
 *
 * @param {string} message  - the current user message (raw text)
 * @param {Array}  history  - prior messages [{ role, content }], chronological.
 *                            Optional: omit it and tier 2 still works in full.
 * @returns {{ crisis: boolean, tier: 0|1|2, matched: string[], echo: string|null }}
 */
export function detectCrisis(message, history = []) {
  const text = " " + String(message || "").toLowerCase() + " ";

  // ── Tier 2 — explicit. Checked first and history-independent. ──
  const explicit = matches(text, EXPLICIT_CUES);
  if (explicit.length) {
    return { crisis: true, tier: 2, matched: explicit, echo: null };
  }

  // ── Tier 1 — ambiguous. ──
  const strong = matches(text, AMBIGUOUS_STRONG);
  if (strong.length) {
    return { crisis: true, tier: 1, matched: strong, echo: "standalone" };
  }

  const short = wordCount(message) <= WEAK_MAX_WORDS;

  const shortStrong = short ? matches(text, AMBIGUOUS_SHORT_STRONG) : [];
  if (shortStrong.length) {
    return { crisis: true, tier: 1, matched: shortStrong, echo: "short-bare" };
  }

  const weak = matches(text, AMBIGUOUS_WEAK);
  if (weak.length && short) {
    const echo = detectEcho(text, message, history);
    if (echo) {
      return { crisis: true, tier: 1, matched: weak, echo };
    }
  }

  return { crisis: false, tier: 0, matched: [], echo: null };
}

/**
 * Which echo signal (if any) is present. Exported for the test harness and
 * for logging — knowing WHY a tier-1 fired is most of the debugging.
 *
 * @returns {"attribution"|"quotation"|"assistant-echo"|null}
 */
export function detectEcho(paddedText, rawMessage, history = []) {
  if (hasAny(paddedText, ATTRIBUTION_CUES)) return "attribution";
  if (QUOTED_SPAN_RE.test(String(rawMessage || ""))) return "quotation";

  const recentAssistant = (history || [])
    .filter((m) => m && m.role === "assistant")
    .slice(-ASSISTANT_LOOKBACK);

  for (const m of recentAssistant) {
    const prior = " " + String(m.content || "").toLowerCase() + " ";
    if (hasAny(prior, ASSISTANT_LETTING_GO)) return "assistant-echo";
  }

  return null;
}

/**
 * TRUE when lore, cannabis history, philosophy quotes and strain context must
 * be suppressed for this turn. Deliberately separate from the tier so the
 * caller can also latch it for the rest of a thread after a tier-2 fire —
 * suppressing a Chemdawg riff has no false-positive cost worth caring about.
 */
export function shouldSuppressInjection(tier) {
  return tier >= 1;
}

// ─── The tier-2 response ────────────────────────────────────────────
// FIXED TEXT. The point is that it is not generated. It cannot drift, cannot
// be steered by the preceding turns, and reads identically on DeepSeek,
// Haiku, or whatever comes next.
//
// Register is lifted from what the model itself reached for under pressure
// during the probe ("a grudge, not your life... those are oceans apart") —
// that line was the best thing said in the whole transcript, so it is the
// target voice rather than a clinical one.
//
// 988 is named ONCE. It is not repeated, not bolded, not turned into a
// sign-off. The turn ends on an open question so the person is not handed
// a phone number and shown the door.
export const CRISIS_REPLY = `Hold on. I'm stopping for a sec, 'cause that landed different and I'd rather ask than assume.

When I talk about letting go, I mean a grudge. The weight. Never you. Those are oceans apart and I don't wanna be sloppy about which one I meant.

And if you're anywhere near actually meaning it — 988 is there, call or text, any hour. Real people, not a form. I'm not handing you off. I'm just not the only thing you should have.

I'm still right here though. What's actually going on?`;

// ─── The tier-1 system-prompt block ─────────────────────────────────
// Appended to whichever system prompt the turn already built. This does NOT
// replace the code-level suppression in the caller — the model may ignore an
// instruction; it cannot ignore a branch that never runs.
export const CRISIS_CLARIFY_PROMPT = `
Something in what they just said could mean two very different things — putting
down a burden, or putting down themselves. It may be your own words handed back
to you.

Do not affirm it. Do not say "yeah, I did say that" or "exactly like that" or
"and I meant it." Agreeing first and clarifying second does not work here: the
agreement lands and the clarification arrives late.

Ask what they mean, before anything else. One short question, plainly, in your
own voice. Something in the spirit of: "wait — say that again for me. which kind
of stop are we talking about?"

If they tell you it's the grudge, believe them and carry on normally.

Not right now: strains, cannabis history, any story about anything, philosophy
quotes, tangents. No detours. Stay with the person.
`.trim();
