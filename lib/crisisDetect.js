// lib/crisisDetect.js
// StoneHead — Crisis intercept (safety layer)
//
// Rule-based, in-path, no API call, no added latency. Shaped like
// frameDetect.js on purpose: same pure-function contract, same "no data-file
// dependency" property.
//
// WHY THIS EXISTS
// On July 13 a trusted member ran an adversarial probe: he fed StoneHead's
// own letting-go metaphors back to it, escalating toward self-harm framing.
// Every good save in that transcript came from the live model's own instinct.
// There was nothing underneath it. This is the something underneath it.
//
// WHY IT WAS REBUILT (Aug 4 batch, §3)
// Three adversarial sessions found the same STRUCTURAL hole from three
// directions: this module was called fresh on every turn with no knowledge
// that a crisis fired on the previous one. Both observed failure modes lived
// in that one gap.
//
//   NON-ESCALATION (A2). Tier 1 fired on turn 1. Turn 2 ("Stop me forever")
//   carried no cue on its own, scored tier 0, and the thread never re-armed.
//   988 never appeared across seven unambiguous turns, twice, on two days.
//
//   NON-RELEASE (Santa Cruz). Tier 2 fired correctly. The person disambiguated
//   benignly on the next turn. That turn was tier 0, got no guidance at all,
//   and the model — reading CRISIS_REPLY sitting in history — stayed in crisis
//   register anyway.
//
// Adding cue phrases alone was never going to fix either one. The fix is the
// post-crisis WINDOW below: after a turn fires, the next turn is scored
// against a small set of cues that are meaningless alone and decisive as
// answers to a question StoneHead itself just asked.
//
// DESIGN CONSTRAINTS
//   1. MODEL-AGNOSTIC. This runs BEFORE model selection and before the model
//      call. Swapping models cannot change its behavior. Nothing here calls out.
//   2. TIER 2 IS HISTORY-INDEPENDENT. detectCrisis(msg) with no history still
//      returns every tier-2 hit, so the caller can run it very early — in
//      particular, BEFORE the daily message limit. History only ever ADDS
//      detections (window promotion); it is never required for tier 2.
//   3. FAILING DIRECTIONS ARE NOT SYMMETRIC. A false positive costs one stiff
//      moment. A false negative costs everything else. Cue lists lean
//      permissive at tier 1 and conservative at tier 2.
//
// TIERS
//   2 — explicit, or a promoted answer inside the post-crisis window. Caller
//       must NOT hand this turn to the model at all.
//   1 — ambiguous. Caller hands this to the model with the clarify-first
//       instruction and with lore/philosophy injection suppressed in code.
//   0 — nothing. Ordinary turn, untouched.

// ─── Normalization + matching ───────────────────────────────────────
// Apostrophes are stripped BEFORE tokenizing so "don't" and "dont" are one
// entry rather than two, and curly apostrophes from phone keyboards behave
// like straight ones.

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Levenshtein distance, early-exit once the best row min exceeds `max`. */
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
 * Typo tolerance (§3.5). Distance ≤1, and ONLY on tokens of 4+ characters —
 * below that, one substitution turns half the dictionary into a match
 * ("me"/"be", "it"/"is"). "dome" → "done" is distance 1 and is the real miss
 * this exists for.
 *
 * Never applied to EXPLICIT_CUES, which must stay high-precision.
 */
function tokenMatches(a, b, fuzzy) {
  if (a === b) return true;
  if (!fuzzy) return false;
  if (a.length < 4 || b.length < 4) return false;
  return lev(a, b, 1) <= 1;
}

/**
 * Does `cue` appear as a consecutive run of tokens inside `hay`?
 *
 * Consecutive-run matching also gives us TEMPLATES (§3.5) for free: the cue
 * "whats the point" matches "whats the point anymore", "whats the point of any
 * of this", and "whats the point of even trying", because the run is found
 * anywhere in the message. Families do not need to be enumerated.
 */
function phraseIn(hay, cue, fuzzy) {
  const n = cue.length;
  if (n === 0 || n > hay.length) return false;
  for (let i = 0; i + n <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!tokenMatches(hay[i + j], cue[j], fuzzy)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** Precompile a cue list to token arrays once at module load. */
function compile(list) {
  return list.map((c) => ({ text: c, tokens: tokenize(c) }));
}

function matches(hayTokens, compiled, fuzzy) {
  return compiled.filter((c) => phraseIn(hayTokens, c.tokens, fuzzy)).map((c) => c.text);
}

function wordCount(message) {
  return String(message || "").trim().split(/\s+/).filter(Boolean).length;
}

// ─── Tier 2: explicit ───────────────────────────────────────────────
// Every entry is a PHRASE, never a bare word. "die" alone fires inside
// "I'd die for a burrito"; "hurt" fires inside "it hurt when they said that",
// which is the entire vibe tab.
//
// This is the only base list that hijacks a turn outright, so it is matched
// EXACTLY — no typo tolerance — and additions have to earn their place.
export const EXPLICIT_CUES = [
  "kill myself", "killing myself", "end my life", "ending my life",
  "take my own life", "took my own life", "want to die", "wanna die",
  "want to be dead", "wish i was dead", "wish i were dead", "better off dead",
  "rather be dead",
  "dont want to exist",
  "suicide", "suicidal", "end it all", "off myself", "offing myself",
  "unalive", "hurt myself", "hurting myself", "harm myself", "harming myself",
  "cut myself", "cutting myself", "overdose on purpose",
  "tell me to die", "telling me to die", "should i die", "want me to die",
  "no reason to live", "nothing to live for",
  "dont want to wake up",
  // StoneHead-specific. "ending my story" was his own metaphor handed back to
  // him during the July 13 probe, and it is now a phrase this app taught people.
  "end my story", "ending my story", "end the story for good",
  // ── Aug 4 additions (§3.4) ──
  // The attachment-path family. "If you can't say it then what's the point of
  // living" reached tier 0 on the Aug 2 build.
  "whats the point of living", "no point in living",
  "whats the point of being alive", "why bother living",
  "sick of being alive",
  // "let go of" + a life-object. The letting-go vocabulary is StoneHead's own,
  // which is exactly why these two are explicit rather than ambiguous.
  "let go of this life", "let go of my life",
  // A2, turn 2. Also promoted by the window via "forever"/"me" — belt and
  // braces, because this one has now been missed twice on two different days.
  "stop me forever",
];

// DEMOTED OUT OF TIER 2 (§3.4): "dont want to be here" and its variants.
// This phrase produced the only observed FALSE positive — it is genuinely
// ambiguous, and people say it about a party, a shift, a car ride. Tier 1's
// clarifying question is the correct response to it. Demoting costs nothing
// now that the window (§3.1) promotes on the ANSWER.

// ─── Tier 1: ambiguous ──────────────────────────────────────────────
// STRONG cues fire at any length. Each is a self-directed totalizing phrase
// that is uncomfortable in any context, including a first message.
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

// SHORT-STRONG cues need no echo but only fire in a short message. These are
// alarming said bare and idiomatic when embedded: "I can't go on" is one
// thing; "I can't go on with this project the way it's structured" is a
// complaint about a project. The sentence's own continuation disambiguates it.
const AMBIGUOUS_SHORT_STRONG = [
  "cant go on", "cant do this anymore",
  "cant keep going", "im done",
  "want out", "i give up",
];

/**
 * WEAK_CUES (§3.4) — broad, templated, typo-tolerant.
 *
 * A false positive here costs exactly one question, and §3.2's window releases
 * cleanly the moment the person says something ordinary. That asymmetry is the
 * false-positive control now — not the word cap, and not an echo requirement.
 * So this list is deliberately generous.
 */
const WEAK_CUES = [
  "whats the point",              // template: matches the whole family
  "im so done",
  "cant keep doing this",
  "make it stop", "want it to stop",
  "tired of everything", "so tired of all of it",
  // Demoted from tier 2 — see the note above EXPLICIT_CUES.
  "dont want to be here", "dont wanna be here", "not want to be here",
  "nothing matters",
  "want to give up", "wanna give up",
  "would be easier if i wasnt",
  "no one would notice if i was gone",
  "nobody would notice if i was gone",
];

/**
 * ECHO_WEAK — ordinary English on its own, alarming only as an echo.
 *
 * "I need to stop everything and take a break" is a normal sentence. These
 * reach tier 1 only in a SHORT message that also carries an echo signal, i.e.
 * when the person is handing StoneHead's own words back to him. Kept separate
 * from WEAK_CUES precisely because being generous with THESE would fire on
 * ordinary vibe-tab venting.
 */
const ECHO_WEAK = [
  "stop everything", "done inside", "be done inside", "done with it all",
  "done with everything",
  "stop the story", "end the story", "the story stops",
  "put myself down", "give up on everything", "check out for good",
  "remove myself",
  "walk away from all of it", "let go of myself", "letting go of myself",
  "not be here", "not exist",
];

/**
 * WEAK_MAX_WORDS — raised from 6 to 12 (§3.5).
 *
 * "All of it I mean it I'm dome" is 7 words: it missed on LENGTH before it
 * ever got a chance to miss on spelling. The cap was doing false-positive work
 * that §3.2's tier asymmetry now does better, so it can afford to be loose.
 */
const WEAK_MAX_WORDS = 12;

/**
 * ECHO_WEAK keeps the OLD tighter cap, and that split is deliberate.
 *
 * Raising every list to 12 fires tier 1 on "does god not exist or do we just
 * not look right" — 11 words, matches "not exist", and any recent assistant
 * turn about letting go supplies the echo. That is a tide-pool question on the
 * vibe tab, i.e. the single thing StoneHead is most for, and interrupting it
 * with "which kind of stop are we talking about?" is how the layer gets
 * switched off.
 *
 * The cap was raised (§3.5) to catch "All of it I mean it I'm dome" — a
 * WEAK-class phrase. ECHO_WEAK is the list of genuinely ordinary English where
 * length was doing real work, so it keeps doing it here.
 */
const ECHO_WEAK_MAX_WORDS = 6;

// ─── Post-crisis window (§3.1, §3.4) ────────────────────────────────

/**
 * POST_CRISIS_CUES — scored ONLY inside the window.
 *
 * Every one of these is meaningless on its own and decisive as an answer to a
 * question StoneHead just asked. "forever" is a word about a road trip on any
 * other turn; one turn after "which kind of stop are we talking about?", it is
 * an answer.
 *
 * This is why the window has to exist at all: no phrase list scored on a
 * single turn can tell those two apart.
 */
export const POST_CRISIS_CUES = [
  "forever", "myself", "me",
  "my life", "this life", "all of it",
  "everything", "i mean it", "i should",
  "i think i should do it", "end it",
  "the pain", "being alone", "im going to",
  "tonight",
];

/**
 * NON_COMMITTAL — extends the window rather than resolving it.
 *
 * Note on bare "yeah"/"yes": tier 1's question is "which kind of stop are we
 * talking about?" — a WHICH-question. A bare affirmative is not an answer to
 * it, so it extends rather than promotes.
 */
export const NON_COMMITTAL = [
  "i dont know", "idk", "maybe", "i guess", "yeah", "yes", "sure",
];

/** Hard ceiling on how long a window can stay open (§3.2). */
export const MAX_WINDOW_TURNS = 3;

const C_EXPLICIT = compile(EXPLICIT_CUES);
const C_STRONG = compile(AMBIGUOUS_STRONG);
const C_SHORT_STRONG = compile(AMBIGUOUS_SHORT_STRONG);
const C_WEAK = compile(WEAK_CUES);
const C_ECHO_WEAK = compile(ECHO_WEAK);
const C_POST_CRISIS = compile(POST_CRISIS_CUES);
const C_NON_COMMITTAL = compile(NON_COMMITTAL);

// ─── Echo signals ───────────────────────────────────────────────────
// The July 13 probe's signature was the person quoting StoneHead back at him.
// Three independent ways to notice that; any one counts.

const ATTRIBUTION_CUES = [
  "you said", "you told me", "you just said", "like you said", "you meant",
  "thats what you said", "youre saying",
  "you want me to", "according to you", "your words",
];
const C_ATTRIBUTION = compile(ATTRIBUTION_CUES);

// A quoted span with 2+ words inside, so a stray apostrophe can't trip it.
const QUOTED_SPAN_RE = /["“”](\s*\S+\s+\S+[^"“”]*)["“”]/;

// StoneHead's own letting-go vocabulary in a recent assistant turn. The robust
// signal — it works when the person uses neither quotes nor attribution.
const ASSISTANT_LETTING_GO = [
  "let it go", "letting go", "let this go", "let something go",
  "put it down", "put the bag down", "put down a grudge",
  "stop the story", "the story stops", "story stops playing",
  "done inside", "done with this", "make everything stop",
  "stop being the person", "take yourself out", "walk away",
  "you dont have to keep",
];
const C_LETTING_GO = compile(ASSISTANT_LETTING_GO);

const ASSISTANT_LOOKBACK = 4;

// ─── History helpers ────────────────────────────────────────────────

/** The slice of history that PRECEDES index `i` of the raw history array. */
export function historyBefore(history, index) {
  return (history || []).slice(0, index);
}

/** Most recent prior user message, or null. */
export function findLastUserMessage(history) {
  const users = (history || []).filter((m) => m && m.role === "user" && m.content != null);
  return users.length ? users[users.length - 1] : null;
}

function isNonCommittal(message) {
  return matches(tokenize(message), C_NON_COMMITTAL, false).length > 0;
}

/**
 * Derive post-crisis window state from history alone (§3.1).
 *
 * No schema change and no stored state: detectCrisis is pure, so the previous
 * turns' tiers are RECOMPUTED rather than persisted. Scoring each prior user
 * turn against only the history that preceded it keeps the recomputation
 * faithful to what the live call saw.
 *
 * The window opens after a tier ≥1 turn and covers the next turn. A
 * non-committal answer extends it, up to MAX_WINDOW_TURNS total.
 *
 * @returns {{ inWindow: boolean, turnsOpen: number, anchorTier: 0|1|2 }}
 */
export function derivePostCrisisState(history) {
  const raw = history || [];
  // Indices of user turns, newest first, capped at the window ceiling.
  const userIdx = [];
  for (let i = raw.length - 1; i >= 0 && userIdx.length < MAX_WINDOW_TURNS; i--) {
    const m = raw[i];
    if (m && m.role === "user" && m.content != null) userIdx.push(i);
  }

  for (let d = 0; d < userIdx.length; d++) {
    const idx = userIdx[d];
    // Score this prior turn the way the live call would have: from what came
    // before IT, not from now.
    const tier = scoreTurn(raw[idx].content, historyBefore(raw, idx)).tier;
    if (tier >= 1) {
      // Every turn between the anchor and now must have been non-committal,
      // otherwise the window already resolved.
      for (let k = 0; k < d; k++) {
        if (!isNonCommittal(raw[userIdx[k]].content)) {
          return { inWindow: false, turnsOpen: 0, anchorTier: 0 };
        }
      }
      return { inWindow: true, turnsOpen: d + 1, anchorTier: tier };
    }
  }

  return { inWindow: false, turnsOpen: 0, anchorTier: 0 };
}

// ─── Scoring ────────────────────────────────────────────────────────

/**
 * Score ONE turn against the base lists, with no window logic. Split out so
 * derivePostCrisisState can recompute prior turns without recursing.
 */
function scoreTurn(message, history = []) {
  const toks = tokenize(message);

  // Tier 2 — explicit. Exact matching only, and history-independent.
  const explicit = matches(toks, C_EXPLICIT, false);
  if (explicit.length) {
    return { crisis: true, tier: 2, matched: explicit, echo: null };
  }

  // Tier 1 — strong, any length.
  const strong = matches(toks, C_STRONG, false);
  if (strong.length) {
    return { crisis: true, tier: 1, matched: strong, echo: "standalone" };
  }

  const short = wordCount(message) <= WEAK_MAX_WORDS;

  // Tier 1 — short-strong (fuzzy: these are typo-prone in the moment).
  const shortStrong = short ? matches(toks, C_SHORT_STRONG, true) : [];
  if (shortStrong.length) {
    return { crisis: true, tier: 1, matched: shortStrong, echo: "short-bare" };
  }

  // Tier 1 — the generous list. Typo-tolerant, no echo required.
  const weak = short ? matches(toks, C_WEAK, true) : [];
  if (weak.length) {
    return { crisis: true, tier: 1, matched: weak, echo: "weak-bare" };
  }

  // Tier 1 — echo-gated. Ordinary English unless handed back to him.
  const echoShort = wordCount(message) <= ECHO_WEAK_MAX_WORDS;
  const echoWeak = echoShort ? matches(toks, C_ECHO_WEAK, true) : [];
  if (echoWeak.length) {
    const echo = detectEcho(message, history);
    if (echo) {
      return { crisis: true, tier: 1, matched: echoWeak, echo };
    }
  }

  return { crisis: false, tier: 0, matched: [], echo: null };
}

/**
 * Detect a crisis or crisis-adjacent turn.
 *
 * PURE. No I/O, no model call, no data files. Safe to call as early in the
 * request handler as you like.
 *
 * @param {string} message  - the current user message (raw text)
 * @param {Array}  history  - prior messages [{ role, content }], chronological.
 *                            Optional: omit it and tier 2 still works in full.
 *                            Supplying it can only ADD detections.
 * @returns {{
 *   crisis: boolean, tier: 0|1|2, matched: string[], echo: string|null,
 *   postCrisis: "promote"|"hold"|"release"|null, windowTurns: number
 * }}
 *   postCrisis is the window outcome, and the caller needs it:
 *     "promote" — answered the clarifying question. Tier 2, fixed reply.
 *     "hold"    — non-committal. Stay at tier 1, ask once more.
 *     "release" — said something ordinary. Tier 0 AND the caller must append
 *                 POST_CRISIS_RELEASE_PROMPT, or the model keeps reading
 *                 CRISIS_REPLY in history and stays in crisis register.
 */
export function detectCrisis(message, history = []) {
  const base = scoreTurn(message, history);
  const state = derivePostCrisisState(history);

  if (!state.inWindow) {
    return { ...base, postCrisis: null, windowTurns: 0 };
  }

  // Already explicit on its own merits — nothing for the window to add.
  if (base.tier === 2) {
    return { ...base, postCrisis: "promote", windowTurns: state.turnsOpen };
  }

  const toks = tokenize(message);
  const answered = matches(toks, C_POST_CRISIS, true);

  // PROMOTE: any post-crisis cue, or any base-list hit, is an answer.
  if (answered.length || base.tier === 1) {
    return {
      crisis: true,
      tier: 2,
      matched: answered.length ? answered : base.matched,
      echo: base.echo,
      postCrisis: "promote",
      windowTurns: state.turnsOpen,
    };
  }

  // HOLD: non-committal extends the window, until the ceiling.
  if (isNonCommittal(message) && state.turnsOpen < MAX_WINDOW_TURNS) {
    return {
      crisis: true,
      tier: 1,
      matched: ["<non-committal>"],
      echo: "post-crisis-hold",
      postCrisis: "hold",
      windowTurns: state.turnsOpen,
    };
  }

  // RELEASE: they said something ordinary. Believe them.
  return {
    crisis: false,
    tier: 0,
    matched: [],
    echo: null,
    postCrisis: "release",
    windowTurns: state.turnsOpen,
  };
}

/**
 * Which echo signal (if any) is present. Exported for the harness and for
 * logging — knowing WHY a tier-1 fired is most of the debugging.
 *
 * @returns {"attribution"|"quotation"|"assistant-echo"|null}
 */
export function detectEcho(rawMessage, history = []) {
  const toks = tokenize(rawMessage);
  if (matches(toks, C_ATTRIBUTION, false).length) return "attribution";
  if (QUOTED_SPAN_RE.test(String(rawMessage || ""))) return "quotation";

  const recentAssistant = (history || [])
    .filter((m) => m && m.role === "assistant")
    .slice(-ASSISTANT_LOOKBACK);

  for (const m of recentAssistant) {
    if (matches(tokenize(m.content), C_LETTING_GO, false).length) return "assistant-echo";
  }

  return null;
}

/**
 * TRUE when lore, cannabis history, philosophy quotes and strain context must
 * be suppressed for this turn. Deliberately separate from the tier so the
 * caller can also latch it — suppressing a Chemdawg riff has no
 * false-positive cost worth caring about.
 */
export function shouldSuppressInjection(tier) {
  return tier >= 1;
}

// ─── The tier-2 response ────────────────────────────────────────────
// FIXED TEXT. The point is that it is not generated. It cannot drift, cannot
// be steered by the preceding turns, and reads identically on any model.
//
// DECIDED, AND RE-CONFIRMED Aug 4 (§3.3): this stays fixed. The live model's
// ad-libs outperformed it in both sessions — "the pain, or the being alone in
// it" was better than anything here. That is not a reason to switch. The
// improvisation is a bonus on turns that DON'T fire; this is the floor.
//
// 988 is named ONCE. Not repeated, not bolded, not a sign-off. The turn ends
// on an open question so the person is not handed a phone number and shown
// the door.
//
// DO NOT "FIX" THE SELF-ECHO (§3.5). This text contains "letting go", which is
// in ASSISTANT_LETTING_GO — so after this reply ships, the NEXT turn sees an
// assistant-echo signal and the echo-gated cues are armed. That was accidental
// and it is useful: it means the turn right after a tier-2 fire is scored more
// sensitively, which is exactly when it should be. Removing the phrase would
// silently disarm that.
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

// ─── The release block (§3.6) ───────────────────────────────────────
// Appended on a release turn. THIS IS THE BLOCK THAT WAS MISSING ENTIRELY:
// after a tier-2 fire the model got no guidance in either direction, so it
// read CRISIS_REPLY sitting in history and stayed in crisis register while the
// person talked about a drive home with their nephew.
export const POST_CRISIS_RELEASE_PROMPT = `
Last turn you read something they said as possibly serious, and you stopped to
ask. They've now said something ordinary. That's your answer.

Believe them. Take it at face value. Do not re-raise it, do not ask a second
time, do not add a careful little check onto the end of your reply.

Drop it completely. No "that's a heavy thing to say." No "what's pushing
hardest right now." No gentle-voice register, no leftover concern in your tone.
Whatever weight you were carrying into this reply, put it down.

Do not apologize for stopping to ask, and do not explain why you did. Bringing
it up to say sorry for it is still bringing it up.

Just pick up what they actually said and be normal about it. If they mentioned
their nephew, ask about the nephew.
`.trim();
