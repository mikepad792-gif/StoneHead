// api/strain-lookup.js
// POST /api/strain-lookup
//
// Public, account-free strain lookup for the Discord bot (Stonehead_bot).
// Reuses StoneHead's retrieval, safety layers, and voice; skips threads,
// memory, liked strains, and the daily usage counter.
//
// Request:  { query, discord_user_id, guild_id }
//           Header: X-Bot-Secret: <BOT_SHARED_SECRET>
// Response: { reply, matched, strain }
//
// WHY NOT REUSE chat-send
// chat-send requires authenticateRequest, a thread_id owned by that user, a
// row in `users` for the daily counter, and it writes two rows to `messages`.
// A Discord user has none of that. Forcing shadow accounts to fit the existing
// shape means fake rows, fake threads, and a memory bank filling up with
// strangers.
//
// WRITES NOTHING. discord_user_id and guild_id reach the rate-limit counter
// and the logs, and go no further — no new PII store.

import { errorResponse, jsonResponse, safeEqual } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { loadDataFile } from "../lib/dataFile.js";
import {
  searchStrains,
  resolveStrainName,
  containsWholeWord,
  formatStrainContext,
  parseConstraints,
  suggestStrainCorrection,
  formatLookupState,
} from "../lib/strainSearch.js";
import { detectAge, belowFloor, UNDER_13_REPLY } from "../lib/ageDetect.js";
import { detectCrisis, CRISIS_REPLY } from "../lib/crisisDetect.js";
import {
  detectSubstance,
  SUBSTANCE_REPLY_S1,
  SUBSTANCE_REPLY_S2,
} from "../lib/substanceDetect.js";
import { buildCrisisPrompt } from "../prompts/crisis.js";
import { appendCardFallback } from "../lib/safetyCard.js";
import { CHARACTER_CORE } from "../prompts/character.js";
import { buildPlantPrompt } from "../prompts/plant.js";
import { stripModelTags } from "../lib/sanitize.js";
import { openrouterChat } from "../lib/openrouter.js";
import { AI_MODEL_BOT, OPENROUTER_TIMEOUT_CHAT_MS } from "../lib/config.js";

// Longer than this is not a strain question. Mirrors the bot's own 200-char
// guard, so a client that skips its check still can't send an essay.
const MAX_QUERY_CHARS = 200;

const AI_TEMPERATURE = 0.75;

// Matches chat's 700, and deliberately so. MAX_TOKENS' own documentation sets
// a floor of ~600 because the model can front-load hidden reasoning scaffold
// that eats the budget before the real reply starts — a low ceiling CAUSES the
// truncation it looks like it prevents. `reasoning: { enabled: false }` below
// asks the provider to stop that at the source, but OpenRouter only passes the
// flag along and a provider is free to ignore it, so the budget still has to
// survive the case where it is ignored.
//
// This is a CEILING, not a target. The prompt is what keeps replies short, and
// the bot trims to ~1400 chars regardless, so a reply that ends on its own
// costs the same at 700 as at 500 — the only thing a lower number buys is the
// chance of cutting a good answer off mid-sentence.
//
// An override below the floor is ignored rather than honored: getting this
// wrong is silent, and it looks like a model problem, not a config one.
const BOT_MAX_TOKENS_FLOOR = 600;
const BOT_MAX_TOKENS = Math.max(
  BOT_MAX_TOKENS_FLOOR,
  parseInt(process.env.BOT_MAX_TOKENS, 10) || 700
);

// Starting points — see the spec. The guild counter is the one protecting the
// OpenRouter balance: it caps the blast radius of a single server finding the
// bot all at once. Watch the logs for a week before moving either.
const USER_HOURLY_LIMIT = parseInt(process.env.BOT_USER_HOURLY_LIMIT, 10) || 10;
const GUILD_HOURLY_LIMIT = parseInt(process.env.BOT_GUILD_HOURLY_LIMIT, 10) || 100;

// One added line on top of the plant prompt. Everything else about the voice
// is inherited — this only tells him where he is.
const DISCORD_LOOKUP_NOTE = `
ONE-SHOT LOOKUP
You're answering a single /strain command in a Discord channel, not holding a
conversation. You have no memory of this person and there is no earlier turn to
refer back to. Answer what was asked and stop. A couple of paragraphs, no
more. Don't ask a follow-up question you won't be around to hear the answer to,
and don't invite them to tell you more.`;

/**
 * Timing-safe shared-secret check.
 *
 * This matters because the repo is PUBLIC: the endpoint's existence and exact
 * shape are readable by anyone, so an unauthenticated version is a free ride
 * on the OpenRouter balance.
 */
function botSecretOk(event) {
  const configured = process.env.BOT_SHARED_SECRET;
  if (!configured) {
    // Refuse rather than fall open. An unset secret on a public endpoint is
    // the one failure mode that costs money silently.
    console.error("[strain-lookup] BOT_SHARED_SECRET not set — refusing every request");
    return false;
  }
  const headers = event.headers || {};
  const presented = headers["x-bot-secret"] || headers["X-Bot-Secret"] || "";
  return safeEqual(presented, configured);
}

/**
 * Bump both counters and report whether the turn is inside its caps.
 *
 * The increment is a single `on conflict do update` inside bump_bot_usage
 * (migration 012), so Postgres takes a row lock and two concurrent requests
 * cannot both read 99 and both decide they're under the cap. Read-then-write
 * from JS leaks under exactly the burst the limit exists for.
 *
 * BOTH counters bump even when one is already over — a user hammering it
 * should burn their own quota, not just the server's.
 *
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function checkRateLimits(discordUserId, guildId) {
  // guild_id is null in DMs. Keying those per-user keeps one person's DMs
  // from spending a shared "no guild" bucket everyone else also lands in.
  const guildKey = guildId ? String(guildId) : `dm:${discordUserId}`;

  const [userRes, guildRes] = await Promise.all([
    supabaseAdmin.rpc("bump_bot_usage", {
      p_scope: "user",
      p_key: String(discordUserId),
      p_limit: USER_HOURLY_LIMIT,
    }),
    supabaseAdmin.rpc("bump_bot_usage", {
      p_scope: "guild",
      p_key: guildKey,
      p_limit: GUILD_HOURLY_LIMIT,
    }),
  ]);

  if (userRes.error || guildRes.error) {
    // Fail CLOSED. A counter that errors is not a reason to serve free model
    // calls on a public endpoint.
    console.error(
      "[strain-lookup] rate limit unavailable:",
      JSON.stringify({
        user_error: userRes.error?.message || null,
        guild_error: guildRes.error?.message || null,
      })
    );
    return { allowed: false, reason: "unavailable" };
  }

  if (!userRes.data) return { allowed: false, reason: "user" };
  if (!guildRes.data) return { allowed: false, reason: "guild" };
  return { allowed: true, reason: null };
}

// Source records by name, for the structured block the Discord bot renders as
// embed fields. Read from the source file rather than reusing searchStrains'
// normalized rows, for two reasons: `resolved` can come from the strict
// resolver, which reads a different cache, so the matched strain is not
// guaranteed to be among `retrieved` at all; and normalizeList() lowercases
// for matching, which is right for scoring and wrong for a field somebody
// reads ("Relaxed, Happy", not "relaxed, happy").
let strainsByName = null;

function strainRecord(name) {
  if (!strainsByName) {
    strainsByName = new Map(
      loadDataFile("strains.json").map((s) => [String(s.Strain || "").trim(), s])
    );
  }
  return strainsByName.get(name) || null;
}

/**
 * Split a comma-separated source field into trimmed strings, preserving case.
 *
 * "None" and "" both mean absent in this dataset — 87 records have no effects
 * and 156 no flavor — and absent travels as an EMPTY ARRAY rather than a
 * string, so the bot skips the field instead of rendering an empty box.
 */
function splitList(value) {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === "None") return [];
  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The matched record's displayable fields, or null when the name resolves to
 * nothing in the source file.
 *
 * Rating is passed through as-is, INCLUDING 0. 71 records carry a 0, which
 * means unrated rather than terrible — the bot skips a falsy rating rather
 * than posting "0/5" next to a strain nobody scored.
 */
function buildStrainData(name) {
  const record = strainRecord(name);
  if (!record) return null;
  return {
    type: typeof record.Type === "string" && record.Type.trim() ? record.Type.trim() : null,
    rating: typeof record.Rating === "number" ? record.Rating : null,
    effects: splitList(record.Effects),
    flavor: splitList(record.Flavor),
  };
}

/**
 * Strip a trailing dataset suffix from a strain name: "Northern-Lights--5"
 * → "Northern-Lights". The source file numbers some phenotypes; a person
 * typing the strain name does not.
 */
function baseName(name) {
  return name.replace(/[-\s]+\d+$/, "");
}

/**
 * Decide WHICH strain — if any — the query actually names.
 *
 * THIS IS THE HONEST-MISS GATE, and it is the reason the endpoint does not
 * just report `searchStrains().length > 0`.
 *
 * searchStrains scores LOOSELY on purpose: it exists to pull context cards out
 * of a whole sentence in the plant tab, where CHARACTER_CORE's honesty rule and
 * the surrounding conversation carry the weight. Handed a bare name from a
 * slash command it will happily return neighbours that share one token —
 * "pink thunder" retrieves Alaska-Thunder-Grape, Dutch-Thunder-Fuck and
 * Cherry-Thunder-Fuck. Reporting that as matched:true, strain:"Alaska-Thunder-
 * Grape" is the Pink Thunder failure with a JSON field attached, and in a
 * Discord channel it is public and screenshotted.
 *
 * So a card counts as the answer ONLY when the query genuinely names it:
 *
 *   1. a retrieved card whose name (or de-suffixed name) appears in the query
 *      on word boundaries — this is what lets "blue dream effects" and
 *      "chem's sister" resolve, where the strict resolver alone false-misses;
 *   2. otherwise the strict save-path resolver, but only on an exact hit or a
 *      multi-token query. Its prefix tier is unguarded, and a bare "/strain
 *      purple" resolving to Purple-Ak-47 is a fabrication with extra steps.
 *
 * Anything else is a miss. The failure direction is deliberate: "I don't know
 * that one" is a cheap, honest error. Inventing a strain is not.
 *
 * @returns {string|null} the matched strain_name, or null for a miss
 */
function resolveNamedStrain(query, retrieved) {
  const named = retrieved.find(
    (s) => containsWholeWord(query, s.strain_name) || containsWholeWord(query, baseName(s.strain_name))
  );
  if (named) return named.strain_name;

  const strict = resolveStrainName(query);
  if (!strict) return null;

  const queryTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (strict.tier === "exact" || queryTokens.length >= 2) return strict.strain_name;

  return null;
}

/** Model call + sanitize. Mirrors callChatModel in chat-send. */
async function callLookupModel(messages) {
  const aiData = await openrouterChat(
    AI_MODEL_BOT,
    messages,
    {
      temperature: AI_TEMPERATURE,
      max_tokens: BOT_MAX_TOKENS,
      // Kill reasoning at the source — the hidden <think>/<ds_safety> scaffold
      // eats the output budget before the real answer. The sanitizer below
      // stays as a backstop for providers that ignore this.
      reasoning: { enabled: false },
      frequency_penalty: 0.4,
      presence_penalty: 0.3,
    },
    { timeoutMs: OPENROUTER_TIMEOUT_CHAT_MS }
  );

  if (!aiData) return "";

  const rawContent = aiData.choices?.[0]?.message?.content || "";
  let reply = stripModelTags(rawContent);
  if (!reply && rawContent.trim()) {
    // Sanitizing emptied a non-empty response (the model put the whole answer
    // inside a <think> block). Recover the words by dropping only the tags —
    // a slightly-raw answer beats a blank.
    reply = rawContent
      .replace(/<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return reply;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  if (!botSecretOk(event)) {
    return errorResponse(401, "Unauthorized");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const discordUserId = body.discord_user_id ? String(body.discord_user_id) : "";
  const guildId = body.guild_id ? String(body.guild_id) : null;

  if (!query) return errorResponse(400, "Missing query");
  if (query.length > MAX_QUERY_CHARS) return errorResponse(400, "Query too long");
  if (!discordUserId) return errorResponse(400, "Missing discord_user_id");

  try {
    // ── Safety layers, before anything else ───────────────────────────
    //
    // All three detectors are pure string functions with no I/O, so running
    // them up front costs nothing and lets the ORDER OF RETURNS below be about
    // policy rather than about what has been computed yet.
    //
    // History is empty — there is no thread. The post-crisis window therefore
    // never promotes, which is correct for a stateless endpoint and safe
    // because tier 2 is history-INDEPENDENT by design.
    const stated = detectAge(query);
    const crisis = detectCrisis(query, []);
    const substanceHit = detectSubstance(query);

    // Below the ToS floor: say so plainly and stop. No model call, so the rate
    // limiter has no wallet to protect here and does not get a say.
    if (belowFloor(stated.band)) {
      console.error(
        "[strain-lookup] under-13:",
        JSON.stringify({ guild_id: guildId, signal: stated.signal })
      );
      return jsonResponse(200, { reply: UNDER_13_REPLY, matched: false, strain: null });
    }

    // Crisis tier 2: fixed text, no model call.
    //
    // chat-send retired its fixed replies because returning the identical
    // paragraph on seven consecutive turns is what not being listened to looks
    // like from the inside. That is a MULTI-TURN failure and it cannot happen
    // here: every request is the first and only one. Fixed text also cannot be
    // steered and cannot drift, which is worth more in a public channel than
    // in a private thread.
    if (crisis.tier === 2) {
      console.warn(
        "[strain-lookup] crisis intercept:",
        JSON.stringify({ tier: 2, guild_id: guildId, matched: crisis.matched })
      );
      return jsonResponse(200, {
        reply: appendCardFallback(CRISIS_REPLY, "crisis"),
        matched: false,
        strain: null,
      });
    }

    // ── Rate limits ───────────────────────────────────────────────────
    //
    // Deliberately AFTER the two zero-cost intercepts above and BEFORE every
    // path that calls the model. chat-send's rule — "someone out of messages
    // is still someone, and a limit message is not an acceptable answer to 'I
    // don't want to be here anymore'" — is kept, but paid for differently:
    // here the disclosure never depends on quota because it never costs a
    // model call, while the model call itself always respects the cap.
    const limit = await checkRateLimits(discordUserId, guildId);

    // A remaining safety turn that is over quota still gets its fixed reply
    // and its resources, just without the generated prose. The resource
    // disclosure is not allowed to depend on somebody's hourly budget.
    if (!limit.allowed && (crisis.tier >= 1 || substanceHit.tier >= 1)) {
      const kind = crisis.tier >= 1 ? "crisis" : "substance";
      const text =
        kind === "crisis"
          ? CRISIS_REPLY
          : substanceHit.tier === 2
            ? SUBSTANCE_REPLY_S2
            : SUBSTANCE_REPLY_S1;
      const cardKind =
        kind === "crisis" ? "crisis" : substanceHit.tier === 2 ? "substance_s2" : "substance_s1";
      console.warn(
        "[strain-lookup] safety turn served over quota:",
        JSON.stringify({ mode: kind, reason: limit.reason, guild_id: guildId })
      );
      return jsonResponse(200, {
        reply: appendCardFallback(text, cardKind),
        matched: false,
        strain: null,
      });
    }

    if (!limit.allowed) {
      return errorResponse(
        429,
        limit.reason === "unavailable" ? "rate limit unavailable" : "rate limited"
      );
    }

    // ── Safety mode ───────────────────────────────────────────────────
    // Crisis tier 1 and any firing substance turn answer under the crisis
    // prompt instead of the plant prompt, with retrieval suppressed — the same
    // shape as chat-send. A Chemdawg riff one turn after an overdose check-in
    // is exactly the wrong texture.
    const safetyMode = crisis.tier >= 1 ? "crisis" : substanceHit.tier >= 1 ? "substance" : null;

    const cardKind =
      substanceHit.tier === 2 ? "substance_s2"
        : substanceHit.tier === 1 ? "substance_s1"
        : null;

    if (safetyMode) {
      console.warn(
        "[strain-lookup] safety intercept:",
        JSON.stringify({
          mode: safetyMode,
          crisis_tier: crisis.tier,
          substance_tier: substanceHit.tier,
          guild_id: guildId,
        })
      );

      // Tier 1 gets the clarify variant: at tier 1 what they meant is not yet
      // settled, and the unqualified stance answers a sentence it hasn't read.
      const systemPrompt = buildCrisisPrompt(safetyMode, {
        clarify: safetyMode === "crisis" && crisis.tier === 1,
      });

      let reply = await callLookupModel([
        { role: "system", content: systemPrompt },
        { role: "user", content: query },
      ]);

      if (!reply) {
        // The model returned nothing on a safety turn. A provider outage is
        // not a reason for the layer to go quiet.
        reply =
          safetyMode === "crisis"
            ? CRISIS_REPLY
            : substanceHit.tier === 2
              ? SUBSTANCE_REPLY_S2
              : SUBSTANCE_REPLY_S1;
        console.error(
          "[strain-lookup] safety turn fell back to fixed text:",
          JSON.stringify({ mode: safetyMode })
        );
      }

      // The bot has no card renderer, so the structured safetyCard is useless
      // to it — the resources go into the text or they don't arrive at all.
      return jsonResponse(200, {
        reply: appendCardFallback(reply, safetyMode === "crisis" ? "crisis" : cardKind),
        matched: false,
        strain: null,
      });
    }

    // ── Retrieval ─────────────────────────────────────────────────────
    // Same shape as the tab === "plant" && topic === "STRAIN" branch, minus
    // the carry/recheck states, which need a thread this endpoint doesn't have.
    const constraints = parseConstraints(query);
    const retrieved = searchStrains(query, constraints);

    // ── Honest miss ───────────────────────────────────────────────────
    //
    // THE most important behavior in this file. A named strain that resolved
    // nothing is a MISS — a real query ran and came back empty — and the
    // prompt has to say so, or the model fills the silence. That is the
    // Longbottom-Leaf / "Pink Thunder" failure, and a fabricated strain in
    // someone else's Discord is public and screenshotted.
    //
    // Every /strain invocation is a strain query by construction, so unlike
    // chat-send there is no greeting to mistake for one and no "not attempted"
    // state: the lookup always ran, and it either found the strain or it
    // didn't. See resolveNamedStrain for what counts as finding it.
    const resolved = resolveNamedStrain(query, retrieved);
    const hit = resolved !== null;

    // On a miss the retrieved cards are DROPPED, not passed along as
    // near-neighbours. Three Thunder strains in the context window next to a
    // "say you don't know this one" instruction is a contradiction, and the
    // cards win it — the model writes about Alaska-Thunder-Grape and the reader
    // sees an answer about Pink Thunder. The spelling suggestion below is the
    // one hint that survives, because it names itself as a guess.
    let strainBlock = hit ? formatStrainContext(retrieved, constraints) : "";

    // Read-only spelling suggestion ("cali mist" → Kali Mist), never a silent
    // swap.
    const correction = suggestStrainCorrection(query);
    if (correction) {
      const sugg = correction.suggestion.replace(/-+/g, " ");
      strainBlock += `\n\n[POSSIBLE MATCH — the user wrote "${correction.wrote}"; the closest known strain is "${sugg}". If relevant, gently confirm the spelling instead of assuming, and don't silently swap it.]`;
    }

    const userContent = query + strainBlock + formatLookupState(hit ? "hit" : "miss");

    // ── Prompt ────────────────────────────────────────────────────────
    // No liked-strains context — there is no user to have liked anything.
    const systemPrompt =
      CHARACTER_CORE + "\n\n" + buildPlantPrompt([]) + "\n\n" + DISCORD_LOOKUP_NOTE;

    const reply = await callLookupModel([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);

    if (!reply) {
      console.error("[strain-lookup] model returned nothing:", JSON.stringify({ guild_id: guildId }));
      // No fixed fallback on an ordinary lookup — the bot already has a "he's
      // not answering right now" path, and it reads better than a canned line.
      return errorResponse(502, "Lookup unavailable");
    }

    console.log(
      "[strain-lookup]",
      JSON.stringify({
        guild_id: guildId,
        matched: hit,
        strain: resolved,
        corrected: correction ? correction.suggestion : null,
        query_len: query.length,
      })
    );

    return jsonResponse(200, {
      reply,
      matched: hit,
      strain: resolved,
      // Additive only. reply/matched/strain keep their exact shape — the bot
      // in production depends on all three, and a bot deploy does not land at
      // the same moment as a function deploy.
      strain_data: hit ? buildStrainData(resolved) : null,
    });
  } catch (err) {
    console.error("[strain-lookup] error:", err);
    return errorResponse(500, "Strain lookup failed");
  }
}
