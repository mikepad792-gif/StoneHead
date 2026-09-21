// api/strain-lookup.js
// POST /api/strain-lookup
//
// Public, account-free strain lookup for the Discord bot (Stonehead_bot).
// Reuses StoneHead's retrieval, safety layers, and voice; skips threads,
// memory, liked strains, and the daily usage counter.
//
// Request:  { query, discord_user_id, guild_id }                 mode "lookup"
//           { mode: "similar", source_strain, discord_user_id, guild_id }
//           Header: X-Bot-Secret: <BOT_SHARED_SECRET>
// Response: { reply, matched, strain, tier, strain_data }
//
// MODES, not endpoints. "similar" powers the "more like this" reaction and
// shares the secret, the rate limiter, and the voice with the lookup. A second
// function would duplicate all three to serve one extra prompt. /history and
// /grow will land the same way.
//
// WHY NOT REUSE chat-send
// chat-send requires authenticateRequest, a thread_id owned by that user, a
// row in `users` for the daily counter, and it writes two rows to `messages`.
// A Discord user has none of that. Forcing shadow accounts to fit the existing
// shape means fake rows, fake threads, and a memory bank filling up with
// strangers.
//
// WHAT IT STORES, because the privacy policy has to match this exactly.
// discord_user_id reaches bot_usage and nothing else: an hourly counter, a
// one-time intro flag, and the last 20 strain names shown to that person
// (migrations 012 and 013). guild_id reaches the counter and the logs. The
// query text is never stored — the logs carry its LENGTH, the strain answered
// with, and the guild id, and no log line on any path carries the user id.
//
// This comment used to read "WRITES NOTHING", which was true until migration
// 013 gave the bot somewhere to remember a person between lookups. Left
// visible rather than silently swapped: the claim moved, and the policy text
// moved with it.

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
import { buildSimilarPrompt } from "../prompts/similar.js";
import { stripModelTags, stripLongDashes } from "../lib/sanitize.js";
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
 * Family-name matching: every significant token of the query appears in the name.
 *
 * WHY EDIT DISTANCE IS NOT ENOUGH. "thunder fuck og" came back "never heard of
 * that one" while the file holds Alaskan, Matanuska, Hawaiian, Dutch and Cherry
 * Thunder Fuck. Distance punishes a missing prefix and an extra suffix, so the
 * family name never clears 0.80 and never reaches the near-miss tier. People
 * type family names without the geographic prefix constantly.
 *
 * Containment, not substring. Substring returns NOTHING for "thunder fuck og"
 * (no name contains "og" inside it the way the query does) and 227 rows for
 * "og" alone. Tokens ask the right question: is every word they typed in this
 * name, wherever it sits.
 *
 * TWO GUARDS, and the second one is the interesting one:
 *
 *   1. Tokens under 3 characters are dropped before matching. That is what
 *      lets "thunder fuck og" match five names that contain no OG at all,
 *      and it is why "og" on its own matches nothing rather than everything.
 *
 *   2. The result has to be SELECTIVE. Two or more significant tokens is
 *      selective by construction. A single token is not — "sour" is in 62
 *      names, "kush" in 173 — so a lone token only counts when it lands on a
 *      handful. "zkittlez" is one token and finds exactly Zkittlez and Blue
 *      Zkittlez, which is the behaviour the spec's own table asks for; "sour"
 *      finds 62 and is refused.
 *
 * The spec wrote guard 2 as a flat "at least 2 significant tokens", which its
 * own test table contradicts on the zkittlez row. Selectivity is what that
 * guard was reaching for: it satisfies every row of the table, and it keeps
 * the case the flat rule would lose (a one-word family name like "wedding",
 * which finds Wedding Cake and nothing else).
 */
const FAMILY_MIN_TOKEN = 3;
const FAMILY_MAX_CANDIDATES = 5;

let nameTokenIndex = null;

function familyIndex() {
  if (!nameTokenIndex) {
    nameTokenIndex = loadDataFile("strains.json")
      .map((r) => String(r.Strain || "").trim())
      .filter(Boolean)
      .map((name) => ({
        name,
        tokens: new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
      }));
  }
  return nameTokenIndex;
}

/** The query's tokens that are long enough to mean anything. */
function familyTokens(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= FAMILY_MIN_TOKEN);
}

/**
 * Strain names containing every significant token, or [] when the query is
 * not selective enough to ask with.
 *
 * Shortest-first, because a cap of five on a bigger set should keep the
 * canonical names: "Blue-Dream" before "Super-Blue-Dream-Haze".
 */
function familyMatches(query) {
  const tokens = familyTokens(query);
  if (!tokens.length) return [];

  const hits = familyIndex()
    .filter((entry) => tokens.every((t) => entry.tokens.has(t)))
    .map((entry) => entry.name);

  // A single token has to earn its place. Over the cap it is a category
  // ("kush", "purple"), not a family, and a category is not an answer.
  if (tokens.length < 2 && hits.length > FAMILY_MAX_CANDIDATES) return [];

  return hits
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, FAMILY_MAX_CANDIDATES);
}

/**
 * The part of a family name that tells it apart from the others.
 *
 * "Alaskan-Thunder-Fuck" next to a query of "thunder fuck og" becomes
 * "Alaskan". A button labelled with the whole name is five identical buttons.
 * Falls back to the full display name when stripping leaves nothing, which
 * happens when the query IS the name.
 */
function familyLabel(name, query) {
  const shared = new Set(familyTokens(query));
  const kept = String(name)
    .split(/-+/)
    .filter((part) => part && !shared.has(part.toLowerCase()));
  return (kept.length ? kept : String(name).split(/-+/)).join(" ");
}

/**
 * Is this name safe to put in front of somebody who did not ask for it?
 *
 * The two places below hand out a strain NOBODY NAMED — the no-match card and
 * the "more like this" recommendation. The safety layers run on what a person
 * typed, so they never see a name the endpoint chose on its own, and the
 * database has at least one record ("Suicide-Girl") that trips the crisis
 * detector on sight. Looking that strain up deliberately is intercepted by the
 * layers like any other message; having the bot volunteer it, unprompted, into
 * a channel is a different act, and there is no reading of it that is good.
 *
 * Written as a filter over the detectors rather than a list of names, so a
 * rebuilt strains.json cannot quietly reintroduce the problem.
 */
function safeToVolunteer(name) {
  const asText = String(name || "").replace(/-+/g, " ");
  if (!asText.trim()) return false;
  if (belowFloor(detectAge(asText).band)) return false;
  if (detectCrisis(asText, []).tier > 0) return false;
  if (detectSubstance(asText).tier > 0) return false;
  return true;
}

// Precomputed profile neighbours, keyed by strain name. See
// scripts/build-similar-strains.mjs — the point of the table is that the model
// is HANDED a strain rather than asked to think of one, because a model asked
// for "something similar" invents a name that was never in the database.
let similarTable = null;

function similarCandidates(name) {
  if (!similarTable) similarTable = loadDataFile("similar-strains.json");
  const rows = similarTable[name];
  if (!Array.isArray(rows)) return [];
  // The same guard as the no-match card, for the same reason: this is a strain
  // the endpoint chose, not one anybody asked about. No entry currently trips
  // it, which is exactly why it has to be enforced here and not assumed.
  return rows.filter((r) => r && r.strain && safeToVolunteer(r.strain));
}

/**
 * Names eligible to be offered as a no-match card.
 *
 * The filter deliberately MATCHES scripts/build-similar-strains.mjs: a real
 * description, and both an effects and a flavor list. Two reasons. A card with
 * no profile is a worse outcome than the apology it replaces. And matching the
 * filter means every strain offered here is also a key in similar-strains.json
 * later, so the "more like this" tap works on a no-match card instead of dying
 * on the one path most likely to be tapped.
 */
let fullRecordPool = null;

function unrelatedPool() {
  if (!fullRecordPool) {
    fullRecordPool = loadDataFile("strains.json")
      .filter(
        (r) =>
          String(r.Description ?? "").trim().length > 40 &&
          splitList(r.Effects).length > 0 &&
          splitList(r.Flavor).length > 0
      )
      .map((r) => String(r.Strain || "").trim())
      .filter(Boolean)
      .filter(safeToVolunteer);
  }
  return fullRecordPool;
}

/**
 * Flat random from the pool, skipping anything this user has already seen.
 *
 * FLAT, not rating-weighted. Weighting collapses onto the same handful of
 * famous strains, which makes the feature feel broken to anyone who taps it
 * twice, and the point of the card is that it is worth reading rather than
 * that it is popular.
 */
function pickUnrelatedStrain(recent) {
  const pool = unrelatedPool();
  if (!pool.length) return null;
  const seen = new Set(recent || []);
  const eligible = pool.filter((n) => !seen.has(n));
  // If somebody has genuinely seen everything, repeating beats returning
  // nothing. At 2,000+ records against a 20-name memory this cannot happen,
  // but a silent null here would be an empty card.
  const from = eligible.length ? eligible : pool;
  return from[Math.floor(Math.random() * from.length)];
}

/**
 * A retrieval-shaped card built straight from a source record.
 *
 * Needed because searchStrains scores loosely: asked for "Northern-Lights" it
 * returns Northern-Lights--5 and two cousins and NOT the record of that exact
 * name. On the corrected-spelling path that would mean announcing one strain
 * and handing the model cards for another, which is the embed disagreeing with
 * the prose. Lowercased to match normalizeList, since these sit alongside
 * cards that went through it.
 */
function cardFromRecord(record) {
  return {
    strain_name: String(record.Strain || "").trim(),
    strain_type: String(record.Type || "").toLowerCase().trim(),
    rating: typeof record.Rating === "number" ? record.Rating : 0,
    effects: splitList(record.Effects).map((e) => e.toLowerCase()),
    flavor: splitList(record.Flavor).map((f) => f.toLowerCase()),
    description:
      record.Description && record.Description !== "None"
        ? String(record.Description).trim()
        : "",
  };
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

/**
 * Claim the one-time intro and read this user's recently shown strains.
 *
 * One RPC for both (migration 013), and it runs ALONGSIDE the rate-limit
 * calls rather than after them, because this function still has to fit an 8s
 * model call inside Netlify's 10s ceiling.
 *
 * Failure is not fatal. A database hiccup here should cost a personal touch
 * and a repeated card, not the lookup itself — unlike the rate limiter, there
 * is no money on the other side of this call.
 */
async function beginLookup(discordUserId) {
  const { data, error } = await supabaseAdmin.rpc("begin_bot_lookup", {
    p_user: discordUserId,
  });
  if (error) {
    console.warn("[strain-lookup] begin_bot_lookup failed:", error.message);
    return { introClaimed: false, recent: [] };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    introClaimed: Boolean(row?.intro_claimed),
    recent: Array.isArray(row?.recent) ? row.recent : [],
  };
}

/**
 * Remember that a card was shown, so a later no-match does not repeat it.
 *
 * Every tier records, not just the no-match one: a strain seen through an
 * ordinary lookup is just as stale a suggestion as one seen through a card.
 *
 * The caller starts this and awaits it with the model call, never before one.
 */
async function noteStrainShown(discordUserId, strain) {
  const { error } = await supabaseAdmin.rpc("note_strain_shown", {
    p_user: discordUserId,
    p_strain: strain,
  });
  if (error) console.warn("[strain-lookup] note_strain_shown failed:", error.message);
}

/**
 * mode: "similar" — the "more like this" reaction.
 *
 * WHO PICKS THE STRAIN. The endpoint does, from the precomputed table. The
 * spec sketched `rec_strain` as a request field, but the table lives here and
 * shipping 1.7MB of it to the bot to duplicate the pick would be the wrong
 * half of the system doing the work. `rec_strain` is still accepted — the
 * harness pins a candidate with it, and a future "tap again" can name the one
 * it already used — and it is VALIDATED against that source's own candidate
 * list. An arbitrary pair can therefore never be driven through this endpoint
 * and described as similar, which is the guarantee the precompute exists for.
 *
 * A random pick among the candidates, not index 0: scores tie constantly at
 * the top because effects and flavors are small sets, so tapping twice giving
 * the same strain would read as a broken button.
 *
 * NO SAFETY DETECTORS HERE, and that is not an oversight. They read free text
 * a person wrote, and this request contains none — both names must already be
 * in the table or it is a 400. What this path does need is safeToVolunteer,
 * applied inside similarCandidates, because the strain being handed over is
 * one nobody asked for.
 */
async function handleSimilar(body, discordUserId, guildId) {
  const sourceStrain = body.source_strain ? String(body.source_strain).trim() : "";
  const askedRec = body.rec_strain ? String(body.rec_strain).trim() : "";

  if (!sourceStrain) return errorResponse(400, "Missing source_strain");

  const candidates = similarCandidates(sourceStrain);
  if (!candidates.length) {
    // Not an error state. 190 of 2,351 records have no profile to score, and
    // the bot's job on this is to say nothing rather than to apologize.
    return jsonResponse(404, { error: "No similar strains", source_strain: sourceStrain });
  }

  const chosen = askedRec
    ? candidates.find((c) => c.strain === askedRec)
    : candidates[Math.floor(Math.random() * candidates.length)];
  if (!chosen) return errorResponse(400, "rec_strain is not a candidate for source_strain");

  const record = strainRecord(chosen.strain);
  if (!record) {
    // The table and strains.json disagree, which means the table is stale.
    console.error(
      "[strain-lookup] similar table names a missing strain:",
      JSON.stringify({ source: sourceStrain, rec: chosen.strain })
    );
    return errorResponse(500, "Strain lookup failed");
  }

  const limit = await checkRateLimits(discordUserId, guildId);
  if (!limit.allowed) {
    console.warn(
      "[strain-lookup] rate limited:",
      JSON.stringify({ mode: "similar", guild_id: guildId, reason: limit.reason })
    );
    return errorResponse(429, "Rate limited");
  }

  // Everything true of the recommendation that is NOT part of the overlap.
  // The prompt needs the two lists SEPARATED: handed one merged profile the
  // model narrates the whole thing as common ground, which is the invented
  // similarity this feature is built to avoid.
  const shared = new Set([...(chosen.shared_effects || []), ...(chosen.shared_flavor || [])]);
  const uniqueToRec = [
    ...splitList(record.Effects),
    ...splitList(record.Flavor),
  ].filter((v) => !shared.has(v));

  const sourceName = sourceStrain.replace(/-+/g, " ");
  const recName = chosen.strain.replace(/-+/g, " ");

  const systemPrompt = CHARACTER_CORE + "\n\n" + DISCORD_LOOKUP_NOTE;
  const userContent = buildSimilarPrompt({
    sourceName,
    recName,
    recRecord: formatStrainContext([cardFromRecord(record)], null),
    sharedEffects: chosen.shared_effects || [],
    sharedFlavor: chosen.shared_flavor || [],
    sameType: chosen.same_type || null,
    uniqueToRec,
  });

  // Recorded for the same reason an ordinary card is: a strain seen through a
  // recommendation is a stale no-match card five minutes later.
  const noted = noteStrainShown(discordUserId, chosen.strain);

  const [reply] = await Promise.all([
    callLookupModel([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]),
    noted,
  ]);

  if (!reply) {
    console.error(
      "[strain-lookup] model returned nothing:",
      JSON.stringify({ mode: "similar", guild_id: guildId })
    );
    return errorResponse(502, "Lookup unavailable");
  }

  console.log(
    "[strain-lookup]",
    JSON.stringify({
      mode: "similar",
      guild_id: guildId,
      source: sourceStrain,
      rec: chosen.strain,
      score: chosen.score,
      pinned: Boolean(askedRec),
      candidates: candidates.length,
    })
  );

  return jsonResponse(200, {
    reply,
    // The card IS the strain described, which is all `matched` has ever
    // claimed. Nobody asked for this strain by name, so `tier` is what says
    // where it came from.
    matched: true,
    strain: chosen.strain,
    source_strain: sourceStrain,
    tier: "similar",
    strain_data: buildStrainData(chosen.strain),
  });
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
  // Last, so it catches the recovery path above too. The character file asks
  // him not to use long dashes and the ask does not hold on its own, so the
  // guarantee lives here instead. See stripLongDashes.
  return stripLongDashes(reply);
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

  const mode = typeof body.mode === "string" ? body.mode.trim() : "lookup";
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const discordUserId = body.discord_user_id ? String(body.discord_user_id) : "";
  const guildId = body.guild_id ? String(body.guild_id) : null;

  if (!discordUserId) return errorResponse(400, "Missing discord_user_id");

  // Checked BEFORE the query rules, which belong to the lookup mode alone —
  // a reaction has no typed text to validate.
  if (mode === "similar") {
    try {
      return await handleSimilar(body, discordUserId, guildId);
    } catch (err) {
      console.error("[strain-lookup] similar error:", err);
      return errorResponse(500, "Strain lookup failed");
    }
  }
  if (mode !== "lookup") return errorResponse(400, "Unknown mode");

  if (!query) return errorResponse(400, "Missing query");
  if (query.length > MAX_QUERY_CHARS) return errorResponse(400, "Query too long");

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
    // Alongside the rate-limit calls, not after them. Both are round trips and
    // this function still has a model call to fit inside Netlify's 10s.
    // ── Retrieval ─────────────────────────────────────────────────────
    // Same shape as the tab === "plant" && topic === "STRAIN" branch, minus
    // the carry/recheck states, which need a thread this endpoint doesn't have.
    const constraints = parseConstraints(query);
    let retrieved = searchStrains(query, constraints);

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
    let resolved = resolveNamedStrain(query, retrieved);
    let hit = resolved !== null;

    // On a miss the retrieved cards are DROPPED, not passed along as
    // near-neighbours. Three Thunder strains in the context window next to a
    // "say you don't know this one" instruction is a contradiction, and the
    // cards win it — the model writes about Alaska-Thunder-Grape and the reader
    // sees an answer about Pink Thunder.
    //
    // WHAT PINK THUNDER ACTUALLY WAS, because the distinction decides the
    // branch below: the failure was a SILENT SUBSTITUTION. Cards for a strain
    // the user never named, handed over with nothing saying a swap had
    // happened, so the reply read as an answer about the thing they asked for.
    //
    // An ANNOUNCED correction is a different act. When the reply opens by
    // naming the swap, and the cards are the real record for the strain being
    // named, the user can see exactly what happened and disagree. Nothing is
    // being passed off as something else, which is the part that made Pink
    // Thunder a lie rather than a mistake.
    const correction = suggestStrainCorrection(query);

    // Above this, a correction is confident enough to answer through. Below
    // it, confirming first is the right call. suggestStrainCorrection never
    // returns anything under 0.8, so the confirm band is 0.8 to 0.92.
    //
    // The cost of confirming is not zero: a Discord user gets 10 lookups an
    // hour, and "did you mean X?" spends one of them to say nothing. That is
    // what earns the high band, not a belief that the matcher is infallible.
    const HIGH_CONFIDENCE_CORRECTION = 0.92;

    let correctedFrom = null;
    if (!hit && correction && correction.similarity >= HIGH_CONFIDENCE_CORRECTION) {
      // Re-run retrieval against the corrected name. The cards have to be the
      // real record for the strain actually being answered, or the embed
      // fields and the prose describe different strains.
      //
      // Only when the lookup MISSED. A query that already resolved named a
      // real strain, and a correction pointing somewhere else is then the
      // thing that is wrong, not the query.
      // The suggestion IS a database name — closestStrainName only ever
      // returns one — so it is what gets announced, rather than whatever
      // loose retrieval happens to rank first.
      const record = strainRecord(correction.suggestion);
      if (record) {
        let cards = searchStrains(correction.suggestion, constraints);
        // Guarantee the announced strain's own card is in the block, and
        // first. Without this, "Northern-Lights" retrieves Northern-Lights--5
        // and two cousins, and the reply would describe a strain the embed
        // fields do not.
        if (!cards.some((c) => c.strain_name === correction.suggestion)) {
          cards = [cardFromRecord(record), ...cards].slice(0, 3);
        }
        resolved = correction.suggestion;
        retrieved = cards;
        hit = true;
        correctedFrom = correction.wrote;
      }
    }

    // ── Family picker ─────────────────────────────────────────────────
    //
    // Before the rate limiter ON PURPOSE. This branch makes NO MODEL CALL: it
    // is a token scan over names already in memory, and the reply is a fixed
    // line. The hourly limit exists to cap the OpenRouter balance, and a
    // response that never reaches OpenRouter has no balance to protect.
    //
    // That is also what makes the spec's "the pick is not charged again" true
    // without a second uncharged endpoint: the PICKER is the free half, and
    // the card the button produces is an ordinary lookup that spends the one
    // slot. Charging both would make the bot's own ambiguity cost the person
    // two of their ten.
    //
    // Guarded on the safety detectors because they are computed above and this
    // returns before the intercept below. A crisis message that happens to
    // contain two strain-ish words must not be answered with a button row.
    //
    // AFTER the exact and >= 0.92 tiers, which is the spec's order and not a
    // detail: "blue dream" and "white widow" both contain two significant
    // tokens shared with several names, so a picker that ran first would
    // answer an exact hit with a row of buttons asking which one they meant.
    // `hit` above is already true in that case and this never runs.
    if (!hit && crisis.tier === 0 && substanceHit.tier === 0) {
      const family = familyMatches(query);
      if (family.length >= 2) {
        console.log(
          "[strain-lookup]",
          JSON.stringify({
            tier: "family_picker",
            guild_id: guildId,
            candidates: family.length,
            query_len: query.length,
          })
        );
        return jsonResponse(200, {
          // Hand-written, not generated. Every other fixed line this bot says
          // is written rather than modelled, and a list of buttons does not
          // need prose around it — see the bot's own "Give me a strain name."
          reply: `${query} isn't one I know, but I've got a few in that family.`,
          matched: false,
          strain: null,
          tier: "family_picker",
          strain_data: null,
          // Echoed so the bot can label the buttons with the distinguishing
          // part of each name without re-deriving which tokens were shared.
          query,
          candidates: family.map((name) => ({
            strain: name,
            label: familyLabel(name, query),
          })),
        });
      }
    }

    const [limit, opened] = await Promise.all([
      checkRateLimits(discordUserId, guildId),
      beginLookup(discordUserId),
    ]);
    const { introClaimed, recent: recentStrains } = opened;

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


    // Family tier. Every word they typed is in this name, and it is the ONLY
    // name that fits, so there is nothing to choose between — the two-or-more
    // case returned a button row well above this. "wedding" lands here and
    // answers Wedding Cake.
    //
    // Answered outright like a confident correction rather than offered like a
    // near miss: containment is not a guess. It is still not an exact hit, so
    // the note below makes the reply name what they typed. See §4.
    let familyFrom = null;
    if (!hit) {
      const family = familyMatches(query);
      if (family.length === 1) {
        const record = strainRecord(family[0]);
        if (record) {
          let cards = searchStrains(family[0], constraints);
          if (!cards.some((c) => c.strain_name === family[0])) {
            cards = [cardFromRecord(record), ...cards].slice(0, 3);
          }
          resolved = family[0];
          retrieved = cards;
          hit = true;
          familyFrom = query;
        }
      }
    }

    // ── Always a card ─────────────────────────────────────────────────
    //
    // A miss used to return prose and nothing else, which spends one of ten
    // hourly lookups to say "no". Every tier below ends with a card.
    //
    // What makes that safe is the thing Pink Thunder got wrong. A card is not
    // a claim. A card presented AS THEIR STRAIN when it isn't, is. So `hit`
    // stays false on the two tiers where the card is not what they asked for,
    // the prompt note carries the burden of saying so, and `tier` tells the
    // caller which of the four this was.
    //
    //   exact      the query named a strain in the database
    //   corrected  fuzzy >= 0.92, answered outright as the corrected strain
    //   candidate  fuzzy 0.80..0.92, offered as a maybe, not claimed as theirs
    //   unrelated  nothing close; a strain worth knowing, explicitly not theirs
    let tier = hit ? (correctedFrom ? "corrected" : familyFrom ? "family" : "exact") : null;

    // Tier B. Close enough to be worth putting in front of them, not close
    // enough to answer as though it were theirs. Below the 0.92 bar this used
    // to be a bare "did you mean", which is the shape that costs a lookup and
    // returns nothing.
    if (!hit && correction) {
      const record = strainRecord(correction.suggestion);
      if (record) {
        let cards = searchStrains(correction.suggestion, constraints);
        if (!cards.some((c) => c.strain_name === correction.suggestion)) {
          cards = [cardFromRecord(record), ...cards].slice(0, 3);
        }
        resolved = correction.suggestion;
        retrieved = cards;
        tier = "candidate";
      }
    }

    // Tier C. Nothing close at all. The card is a different strain and the
    // reply has to be unmistakable about that.
    let unrelatedPick = null;
    if (!tier) {
      unrelatedPick = pickUnrelatedStrain(recentStrains);
      const record = unrelatedPick ? strainRecord(unrelatedPick) : null;
      if (record) {
        resolved = unrelatedPick;
        retrieved = [cardFromRecord(record)];
        tier = "unrelated";
      }
    }

    const hasCard = tier !== null;
    let strainBlock = hasCard ? formatStrainContext(retrieved, constraints) : "";

    // §4. EVERY TIER THAT IS NOT AN EXACT HIT NAMES THE QUERY IN THE REPLY.
    // A card screenshotted on its own hides the miss: the title says one
    // strain, the body describes it, and nothing on screen records that the
    // person asked for something else. Quoting what they typed is what makes
    // the substitution auditable by whoever reads it later.
    if (familyFrom) {
      const sugg = resolved.replace(/-+/g, " ");
      strainBlock += `\n\n[FAMILY NAME, AND YOU SAY SO. They typed "${familyFrom}". Every word of that is in ${sugg}, and it is the only strain in the database that fits, so that is what you are answering. Open by quoting what they typed back at them and naming ${sugg} as what you are reading it as. Then answer for ${sugg} in full from the record above. Do not ask them to confirm.]`;
    } else if (correctedFrom) {
      const sugg = resolved.replace(/-+/g, " ");
      strainBlock += `\n\n[SPELLING, AND YOU SAY SO. They typed "${correctedFrom}". You are reading that as "${sugg}", and the record above is ${sugg}. Open by naming that, plainly and in your own words, then answer for ${sugg} in full. Do not stop to ask them to confirm, and do not write as though they had typed it correctly — they didn't, and saying so is the honest part.]`;
    } else if (tier === "candidate") {
      const sugg = resolved.replace(/-+/g, " ");
      strainBlock += `\n\n[NO EXACT MATCH, ONE NEAR THING. They typed "${correction.wrote}". Nothing goes by that name. The record above is ${sugg}, the closest thing in the database, and you are NOT sure it is what they meant.\n\nSay you didn't find what they typed, and QUOTE IT BACK to them so it is on the screen. Then offer ${sugg} as the near thing you do have, name it, and describe it from the record. Offering is not the same as answering: do not write as though ${sugg} is what they asked for.]`;
    } else if (tier === "unrelated") {
      const sugg = resolved.replace(/-+/g, " ");
      strainBlock += `\n\n[NO MATCH AT ALL, AND THE CARD IS SOMETHING ELSE. They typed "${correction ? correction.wrote : query}". Nothing in the database is close to it and you do not know it. The record above is ${sugg}, picked because it is worth knowing. It has NOTHING to do with what they asked for.\n\nTwo halves, in this order, and the seam between them has to be obvious:\n1. You have never heard of what they typed. Say it plainly, and QUOTE THE WORDS THEY TYPED back at them so the card cannot be screenshotted without the miss being visible. No hedging, no "I think I've heard that one".\n2. Then, as a clearly separate offer, hand them ${sugg} — name it, and say outright that it is a different strain, not theirs.\n\nSomeone skimming sees a card sitting under their query and assumes it answers it. The second half has to make that impossible to believe.]`;
    }

    // formatLookupState's MISS text forbids describing effects or lineage,
    // which is right when there is no card and wrong on the two tiers that
    // have one. Those carry their own note above, which says both halves: you
    // do not know theirs, you do know this.
    const lookupNote = hasCard
      ? hit
        ? formatLookupState("hit")
        : ""
      : formatLookupState("miss");

    // First contact. One line, then the answer — the point is that it happens
    // once, not that it is long.
    const introNote = introClaimed
      ? `\n\n[FIRST TIME. This person has never used this bot before. Before you answer, one short line saying who you are, in your own voice. One line. Then straight into the answer. Do not list commands and do not explain what you can do.]`
      : "";

    const userContent = query + strainBlock + lookupNote + introNote;

    // ── Prompt ────────────────────────────────────────────────────────
    // No liked-strains context — there is no user to have liked anything.
    const systemPrompt =
      CHARACTER_CORE + "\n\n" + buildPlantPrompt([]) + "\n\n" + DISCORD_LOOKUP_NOTE;

    // Started BEFORE the model call and awaited with it, so remembering the
    // card costs no wall clock. It is also not allowed to fail the lookup:
    // a dropped write means one possible repeat, which is not worth a 500.
    const noted = hasCard && resolved ? noteStrainShown(discordUserId, resolved) : null;

    const [reply] = await Promise.all([
      callLookupModel([
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ]),
      noted,
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
        tier,
        intro: introClaimed,
        corrected_from: correctedFrom,
        correction_similarity: correction ? Number(correction.similarity.toFixed(3)) : null,
        query_len: query.length,
      })
    );

    return jsonResponse(200, {
      reply,
      // Unchanged meaning: true only when the card IS the strain they asked
      // for. The two tiers that offer something else keep it false, which is
      // what stops an offer reading as an answer.
      matched: hit,
      strain: resolved,
      tier,
      // Additive only. reply/matched/strain keep their exact shape — the bot
      // in production depends on all three, and a bot deploy does not land at
      // the same moment as a function deploy.
      // Keyed off the CARD, not off `hit`. Tiers B and C return a strain the
      // person did not ask for, and its record still has to travel: the embed
      // renders these as its fields, and a card with a name and no fields is
      // the empty box this update exists to stop returning.
      strain_data: hasCard ? buildStrainData(resolved) : null,
    });
  } catch (err) {
    console.error("[strain-lookup] error:", err);
    return errorResponse(500, "Strain lookup failed");
  }
}
