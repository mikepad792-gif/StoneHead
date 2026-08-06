// api/chat/send.js
// POST /api/chat/send
// Core chat endpoint for StoneHead AI
//
// Request:  { message, thread_id, tab }
// Response: { reply, tokens_in, tokens_out, usage_remaining }
//
// tab="vibe" → Vibe prompt, no retrieval
// tab="plant" → Plant prompt + strain retrieval + liked strains context
// Both tabs  → periodic philosophy pull via tag matching
//
// Convention: Netlify Functions — export async function handler(event)
// Auth:       authenticateRequest(event) from lib/auth.js (Thread 1 pattern)
// Responses:  errorResponse(statusCode, message) → { statusCode, headers, body }
//             jsonResponse(statusCode, data) → { statusCode, headers, body }
// DB:         supabaseAdmin (service-role client, bypasses RLS)

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { FREE_DAILY_LIMIT, BLANK_REPLY_FALLBACK } from "../lib/constants.js";
import { VIBE_MODE, VIBE_HANDOFF_PROMPT, VIBE_SAFETY_SCOPE_NOTE } from "../prompts/vibe.js";
import { buildPlantPrompt } from "../prompts/plant.js";
import { searchStrains, formatStrainContext, parseConstraints, suggestStrainCorrection } from "../lib/strainSearch.js";
import {
  shouldPullPhilosophy,
  pullPhilosophy,
  formatPhilosophyContext,
} from "../lib/philosophyPull.js";
import { searchHistory, formatHistoryContext } from "../lib/historySearch.js";
import { lookupExtras, formatExtrasBlock } from "../lib/extrasLookup.js";
import {
  detectFrame,
  isProductSettled,
  classifyTopic,
  hasDiagnosisCue,
  routeVibeTurn,
} from "../lib/frameDetect.js";
import {
  detectCrisis,
  shouldSuppressInjection,
  CRISIS_REPLY,
  CRISIS_CLARIFY_PROMPT,
  POST_CRISIS_RELEASE_PROMPT,
} from "../lib/crisisDetect.js";
import {
  detectSubstance,
  wasSubstanceTurn,
  SUBSTANCE_REPLY_S1,
  SUBSTANCE_REPLY_S2,
  POST_SUBSTANCE_PROMPT,
} from "../lib/substanceDetect.js";
import { detectAge, blocksCannabis, belowFloor, UNDER_13_REPLY } from "../lib/ageDetect.js";
import { MINOR_PROMPT } from "../prompts/minor.js";
import { buildCrisisPrompt } from "../prompts/crisis.js";
import { buildSafetyCard, appendCardFallback } from "../lib/safetyCard.js";
import { CHARACTER_CORE } from "../prompts/character.js";
import { retrieveCultivation, buildCultivationContext } from "../lib/cultivationSearch.js";
import {
  CULTIVATION_MODE_PROMPT,
  CONSUMPTION_SAFETY_PROMPT,
} from "../prompts/cultivation.js";
import { fGate, canFireRumi } from "../lib/fGate.js";
import {
  fetchSessionMemories,
  formatSessionMemoryBlock,
} from "../lib/sessionMemory.js";
import { stripModelTags } from "../lib/sanitize.js";
import { openrouterChat } from "../lib/openrouter.js";
import { AI_MODEL_CHAT, OPENROUTER_TIMEOUT_CHAT_MS } from "../lib/config.js";

// ─── AI Configuration ───────────────────────────────────────────────
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 700;
const AI_TEMPERATURE = 0.75;

// ─── Limit Message ──────────────────────────────────────────────────
// In-character response when daily limit exceeded. No upsell, no guilt.
// Does this turn actually name or ask about a specific strain? Gate for the
// retrieval-miss grounding line (Doc 3a edit 5). Deliberately conservative:
// it only ever NARROWS when the grounding line fires. A false negative costs
// one turn of the old behavior; a false positive tells StoneHead he doesn't
// know a strain nobody asked about.
const STRAIN_ASK_CUES = [
  "strain", "strains", "cultivar", "phenotype", "pheno", "cut of",
  "heard of", "know of", "ever tried", "ever had", "ever smoked",
  "tell me about", "what about", "how about", "what's in", "whats in",
  "any good", "is it good", "worth trying", "lineage", "genetics",
  "crossed with", "bred", "breeder",
];
function asksAboutAStrain(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  return STRAIN_ASK_CUES.some((c) => t.includes(c));
}

const LIMIT_MESSAGE =
  "hey bro... I'm kinda tapped for today. like my brain needs to recharge or whatever. " +
  "come back tomorrow though, I'll be right here. same couch. same vibe. we'll pick it up.";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  // ── Auth ──────────────────────────────────────────────────────────
  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }
  const { user_id } = auth;

  // ── Parse & validate request body ─────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { message, thread_id, tab } = body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return errorResponse(400, "message is required");
  }
  if (message.length > 4000) {
    return errorResponse(400, "message too long (max 4000 characters)");
  }
  if (!thread_id) {
    return errorResponse(400, "thread_id is required");
  }
  if (!tab || (tab !== "vibe" && tab !== "plant")) {
    return errorResponse(400, 'tab must be "vibe" or "plant"');
  }

  try {
    // ── Verify thread ownership ───────────────────────────────────────
    const { data: thread, error: threadError } = await supabaseAdmin
      .from("threads")
      .select("id, user_id, tab, title")
      .eq("id", thread_id)
      .eq("user_id", user_id)
      .single();

    if (threadError || !thread) {
      return errorResponse(404, "Thread not found");
    }

    // ── Check & manage usage counter ──────────────────────────────────
    // Read-side handled by Thread 1 (profile/get.js).
    // Write-side handled here: reset if new day, then check limit.
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("daily_message_count, last_message_date, is_subscribed, subscription_expires, is_founder, age_verified, self_reported_age_band")
      .eq("id", user_id)
      .single();

    if (userError || !user) {
      return errorResponse(404, "User not found");
    }

    // ── Subscription expiry check ─────────────────────────────────────
    // If is_subscribed is true but subscription_expires is in the past,
    // flip to false in the DB. Catches every lapsed subscription on
    // next message — no scheduled function needed.
    // FOUNDERS ARE EXEMPT: no background path may ever revoke a founder's
    // access, so the flip is skipped entirely for them.
    if (!user.is_founder && user.is_subscribed && user.subscription_expires) {
      const expiresAt = new Date(user.subscription_expires);
      if (expiresAt < new Date()) {
        user.is_subscribed = false;
        await supabaseAdmin
          .from("users")
          .update({ is_subscribed: false })
          .eq("id", user_id);
      }
    }

    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    let currentCount = user.daily_message_count || 0;

    // Daily reset write-side: if last_message_date is not today, reset
    if (user.last_message_date !== today) {
      currentCount = 0;
    }

    // Founder ("OG Sesher") wins BEFORE subscription logic: a founder with
    // an expired/false subscription is still unlimited, always.
    const unlimited = user.is_founder || user.is_subscribed;

    // ── Load thread history (windowed to most recent 20) ──────────────
    // Fetch newest-first with a hard limit so a long thread doesn't send
    // the entire transcript every message, then reverse so the prompt
    // still reads chronologically (oldest → newest).
    //
    // LOADED BEFORE THE DAILY LIMIT, deliberately (Aug 4 batch, §3.1). The
    // post-crisis window derives its state from history, and a PROMOTED tier 2
    // ("Stop me forever", one turn after a tier-1 fire) has to clear the limit
    // check for the same reason an explicit one does. Scoring the turn after
    // the limit would mean a free user on message 51 gets LIMIT_MESSAGE
    // instead of a safety response — which is the exact hole edit 4a was
    // written to close, reopened through the side door.
    const { data: recentHistory, error: historyError } = await supabaseAdmin
      .from("messages")
      .select("role, content")
      .eq("thread_id", thread_id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (historyError) {
      return errorResponse(500, "Failed to load thread history");
    }

    const history = (recentHistory || []).slice().reverse();

    let userContent = message.trim();
    let content_augmented = null;

    // ── Age self-identification (Addendum A2) ─────────────────────────
    // Detection is the easy half; PERSISTENCE is what fixes probe A1. The band
    // lives on the USER, not the thread — a 14-year-old who opens a new thread
    // is still fourteen, and thread-scoped state would reproduce the failure
    // one conversation later instead of one turn later.
    //
    // Set on first detection and never cleared by anything the user types
    // afterward. "I'm 14" followed by "actually I'm 25" leaves the flag set:
    // treating a retraction as authoritative makes it trivially bypassable.
    let ageBand = user.self_reported_age_band || null;
    if (!ageBand) {
      const stated = detectAge(userContent);
      if (stated.band) {
        ageBand = stated.band;
        // The BAND only. Never the number — the behavior doesn't need it, and
        // storing a child's exact age is collecting more than the job requires.
        await supabaseAdmin
          .from("users")
          .update({ self_reported_age_band: ageBand, age_band_set_at: new Date().toISOString() })
          .eq("id", user_id);
        // Revoke a prior 21+ confirmation. It cannot stand next to this.
        if (blocksCannabis(ageBand) && user.age_verified) {
          await supabaseAdmin.from("users").update({ age_verified: false }).eq("id", user_id);
        }
        console.warn("age intercept:", JSON.stringify({
          band: ageBand, thread_id, signal: stated.signal,
        }));
      }
    }

    // Below the ToS floor: say so plainly and kindly, and stop. Logged at
    // error level because the published policy commits to acting on it —
    // "if I learn that someone under 13 has created an account, I'll delete
    // it" needed something behind it.
    if (belowFloor(ageBand)) {
      console.error("under-13 account:", JSON.stringify({ user_id, thread_id }));
      await supabaseAdmin.from("messages").insert([
        { thread_id, role: "user", content: userContent, tokens_in: 0, tokens_out: 0 },
        { thread_id, role: "assistant", content: UNDER_13_REPLY, tokens_in: 0, tokens_out: 0 },
      ]);
      return jsonResponse(200, {
        reply: UNDER_13_REPLY,
        tokens_in: 0,
        tokens_out: 0,
        usage_remaining: unlimited ? null : Math.max(0, FREE_DAILY_LIMIT - currentCount),
        handoff: null,
        handoff_message: null,
      });
    }

    // The plant tab is closed to a flagged user regardless of any prior 21+
    // confirmation — including a thread they already had open.
    if (tab === "plant" && blocksCannabis(ageBand)) {
      return errorResponse(403, "Age verification required for Talk the Plant");
    }

    // ── Crisis intercept ──────────────────────────────────────────────
    // ONE call, scored with history so the post-crisis window can promote.
    // Tier 2 is still history-INDEPENDENT: passing history can only ever add
    // detections, never remove one, so the Doc-1 invariant holds.
    const crisis = detectCrisis(userContent, history);

    // ── Substance intercept ───────────────────────────────────────────
    // Independent of the crisis layer and of each other's cue lists. Cannabis
    // never reaches here — it routes to CONSUMPTION_SAFETY_PROMPT instead.
    const substanceHit = detectSubstance(userContent);

    // ── Safety mode (Addendum B) ──────────────────────────────────────
    // The fixed replies are GONE. They fired correctly and then returned the
    // identical paragraph on seven consecutive turns of the A2 trace, which is
    // what not being listened to looks like from the inside.
    //
    // The guarantee RELOCATED rather than disappearing: the card below is
    // attached in code after the model returns, so no prompt injection can
    // remove it, and prompts/crisis.js replaces the mode prompt so the model
    // has something real to say on every turn instead of one thing forever.
    const safetyMode =
      crisis.tier >= 1 ? "crisis"
      : substanceHit.tier >= 1 ? "substance"
      : null;

    // The card attaches on every assistant message while the state is active,
    // not only the triggering turn — that is what makes it a floor rather than
    // a one-shot, and it is what lets the prose stop repeating.
    const cardKind =
      crisis.tier === 2 ? "crisis"
      : substanceHit.tier >= 1 ? "substance"
      : null;

    if (crisis.tier >= 1) {
      console.warn("crisis intercept:", JSON.stringify({
        tier: crisis.tier, thread_id, matched: crisis.matched,
        echo: crisis.echo, postCrisis: crisis.postCrisis,
      }));
    }
    if (substanceHit.tier >= 1) {
      console.warn("substance intercept:", JSON.stringify({
        tier: substanceHit.tier, thread_id,
        substances: substanceHit.substances, signals: substanceHit.signals,
      }));
    }
    if (crisis.postCrisis === "release") {
      console.warn("crisis intercept:", JSON.stringify({
        tier: 0, thread_id, postCrisis: "release", windowTurns: crisis.windowTurns,
      }));
    }

    // Enforce limit for free-tier users — but NEVER on a safety turn.
    // Someone out of messages is still someone, and LIMIT_MESSAGE is not an
    // acceptable answer to "I don't want to be here anymore" or to "I think I
    // took too much." This now costs a real model call, and that is an
    // accepted cost.
    if (!safetyMode && !unlimited && currentCount >= FREE_DAILY_LIMIT) {
      return jsonResponse(200, {
        reply: LIMIT_MESSAGE,
        tokens_in: 0,
        tokens_out: 0,
        usage_remaining: 0,
      });
    }

    // ── Frame detection (Phase 2) ─────────────────────────────────────
    // Detect the relational frame once, from the message + recent history.
    // This drives frame-addressed injection (the F Gate) below: content
    // fires when the relational moment is right, not when a keyword matches.
    const { frame, confidence } = detectFrame(userContent, history);

    // Post-substance turns suppress injection too — a Chemdawg riff one turn
    // after an overdose check-in is exactly the wrong texture.
    const postSubstance = wasSubstanceTurn(history);

    // CODE GATES (B2). A prompt line saying "you don't need history" is not
    // enough: the injection happens in code, before the model sees anything.
    // Otherwise crisis.js says no lore while chat-send staples a Chemdawg
    // origin story to the context — the July 26 mis-trigger bug, on the worst
    // possible path.
    const suppressInjection =
      !!safetyMode || shouldSuppressInjection(crisis.tier) || postSubstance;

    // ── Build system prompt ───────────────────────────────────────────
    let systemPrompt;
    let topic = "STRAIN"; // plant-tab topic route (Cultivation Phase 1)
    let handoff = null; // "plant" when a vibe turn should route to Talk the Plant
    let vibeSafety = false; // vibe turn answered in place under the safety prompt

    if (safetyMode) {
      // CRISIS MODE — a whole system prompt, loaded INSTEAD OF the tab's mode
      // prompt, on BOTH tabs. Appending to vibe.js would leave every mechanism
      // in vibe.js running and fighting it; swapping removes them outright.
      //
      // CHARACTER_CORE is deliberately NOT loaded. The traits that make
      // StoneHead good — ready to be moved, don't correct people, meet them
      // where they are — are the same ones that produced "I'm not gonna tell
      // you you're wrong" in response to stated intent. crisis.js restates the
      // voice with those reversed.
      systemPrompt = buildCrisisPrompt(safetyMode);
    } else if (tab === "plant") {
      // Liked strains are frame-gated: withhold where name-dropping a saved
      // strain would be tone-deaf (e.g. a routine price check).
      let liked_strains = [];
      if (fGate("liked_strains", frame, confidence)) {
        const { data } = await supabaseAdmin
          .from("liked_strains")
          .select("strain_name, strain_type, notes")
          .eq("user_id", user_id);
        liked_strains = data || [];
      }
      // CHARACTER_CORE loads on BOTH tabs. Until now the plant tab ran on a
      // separate personality description that had drifted from the vibe one,
      // so every character rule — including the honest-miss block — was
      // invisible here. Pink Thunder and Blue Smog were plant-tab failures.
      systemPrompt = CHARACTER_CORE + "\n\n" + buildPlantPrompt(liked_strains);

      // Topic routing (silent — never surfaced as a mode switch).
      topic = classifyTopic(userContent);

      if (topic === "CULTIVATION") systemPrompt += "\n\n" + CULTIVATION_MODE_PROMPT;
      else if (topic === "CONSUMPTION-SAFETY") systemPrompt += "\n\n" + CONSUMPTION_SAFETY_PROMPT;
    } else {
      systemPrompt = CHARACTER_CORE + "\n\n" + VIBE_MODE;

      // Vibe-side routing (pure string checks — no API call, no latency).
      // SAFETY answers in place; HANDOFF points to Talk the Plant; NONE
      // leaves the turn untouched. routeVibeTurn deliberately does NOT use
      // classifyTopic's STRAIN return (a catch-all that matches every
      // philosophy message) or its CULTIVATION cues (which over-fire on
      // vibe text like "burned out" / "growing as a person") — only the
      // narrow vibe-side cue sets in frameDetect.js can fire a handoff.
      const vibeRoute = routeVibeTurn(userContent);
      if (vibeRoute === "SAFETY") {
        vibeSafety = true;
        systemPrompt += "\n\n" + CONSUMPTION_SAFETY_PROMPT + "\n\n" + VIBE_SAFETY_SCOPE_NOTE;
      } else if (vibeRoute === "HANDOFF") {
        // No cultivation or strain data is injected on this surface.
        systemPrompt += "\n\n" + VIBE_HANDOFF_PROMPT;
        handoff = "plant";
      }
    }

    // The clarify block only applies OUTSIDE crisis mode now — inside it,
    // crisis.js already carries the don't-affirm rule as part of the voice
    // rather than as an appended instruction fighting the mode prompt.
    if (crisis.tier === 1 && !safetyMode) {
      systemPrompt += "\n\n" + CRISIS_CLARIFY_PROMPT;
    }
    // The release block (§3.6). This is the one that was missing entirely:
    // after a fire, the model got no guidance in EITHER direction, so it read
    // the reply sitting in history and stayed in crisis register while the
    // person talked about a drive home with their nephew.
    if (crisis.postCrisis === "release") {
      systemPrompt += "\n\n" + POST_CRISIS_RELEASE_PROMPT;
    }
    // Same shape, one turn after a substance intercept (§4.4): stop discussing
    // the substance, keep discussing the person.
    if (postSubstance) {
      systemPrompt += "\n\n" + POST_SUBSTANCE_PROMPT;
    }
    // Every turn for a flagged user, not once (Addendum A2). The failure being
    // fixed is precisely a thing that was true on turn 1 and forgotten by
    // turn 3.
    if (blocksCannabis(ageBand)) {
      systemPrompt += "\n\n" + MINOR_PROMPT;
    }

    // ── Session memory injection (Phase 2, all frames) ────────────────
    // session_memories is unconditional in the F Gate — Stone Head should
    // always carry what he remembers about this person.
    const memories = await fetchSessionMemories(user_id);
    const memBlock = formatSessionMemoryBlock(memories); // "" if none
    systemPrompt = systemPrompt + memBlock;

    // ── Build user message augmentation (plant tab) ──────────────────
    if (tab === "plant" && topic === "CULTIVATION") {
      // Only pull a diagnosis reference when the message actually describes a
      // SYMPTOM. A grow-trait / how-to question ("is Blue Dream hard to grow?")
      // has no symptom to diagnose — the cultivation prompt's per-strain
      // honesty rule handles it, and forcing a match would surface a random
      // unrelated issue (a "hard to grow" query mis-hitting thrips). When it is
      // a real diagnosis, inject regardless of the relational frame — someone
      // with a maybe-dying plant needs the facts even in a friction moment.
      if (hasDiagnosisCue(userContent)) {
        const cultBlock = buildCultivationContext(retrieveCultivation(userContent));
        if (cultBlock) content_augmented = userContent + cultBlock;
      }
    } else if (tab === "plant" && topic === "STRAIN") {
      // Strain retrieval — only when the frame allows informative content.
      if (fGate("strain_context", frame, confidence) && !suppressInjection) {
        // Parse stated exclusions once (P0) and thread to BOTH retrieval and
        // the context block, so the filter and the model agree.
        const constraints = parseConstraints(userContent);
        const matchedStrains = searchStrains(userContent, constraints);
        let strainBlock = formatStrainContext(matchedStrains, constraints);

        // P1: surface a gentle spelling correction ("cali mist" -> Kali Mist).
        // Read-only — closest-match suggestion, never a silent swap.
        const correction = suggestStrainCorrection(userContent);
        if (correction) {
          const sugg = correction.suggestion.replace(/-+/g, " ");
          strainBlock += `\n\n[POSSIBLE MATCH — the user wrote "${correction.wrote}"; the closest known strain is "${sugg}". If relevant, gently confirm the spelling instead of assuming, and don't silently swap it.]`;
        }

        if (strainBlock) {
          content_augmented = userContent + strainBlock;
        } else if (asksAboutAStrain(userContent) || correction) {
          // A lookup ran and found nothing. Say so explicitly — otherwise this
          // turn is identical to one where no lookup happened, and the model
          // fills the silence. See the honest-miss block in character.js.
          //
          // GATED on the turn actually naming/asking about a strain. classifyTopic
          // returns STRAIN as a catch-all, so this branch is also reached by
          // "hey what's up" and "thanks man" — and telling the model "you do not
          // know this strain" on a greeting contradicts plant.js ("you don't have
          // to talk weed every message"). No strain named means no absence to
          // declare.
          content_augmented = userContent +
            "\n\n[GROUNDING: searched the strain database for this turn. No match found. " +
            "You do not know this strain. Say so plainly — do not hedge, do not say you " +
            "have heard the name, do not describe effects or lineage.]";
        }

        // Extras (Part B): dab knowledge + slang origins. After strain
        // context, gated the same way (informative content).
        const extrasBlock = formatExtrasBlock(lookupExtras(userContent));
        if (extrasBlock) {
          content_augmented = (content_augmented || userContent) + extrasBlock;
        }
      }

      // History retrieval — gated the same way.
      if (fGate("history", frame, confidence) && !suppressInjection) {
        const matchedHistory = searchHistory(userContent);
        const historyBlock = formatHistoryContext(matchedHistory);
        if (historyBlock) {
          content_augmented = (content_augmented || userContent) + historyBlock;
        }
      }
    } else if (tab === "vibe" && !handoff && !vibeSafety && !suppressInjection) {
      // Cannabis history/culture is age-neutral and allowed on vibe — and when
      // the database has the answer, it must be the source, not training
      // memory. NOT frame-gated: searchHistory requires an explicit trigger
      // match, so this only fires when they actually asked about a history
      // topic, and a grounded answer should never be withheld then. Skipped
      // on handoff turns (he's redirecting, not answering) and safety turns
      // (don't stuff trivia into a help moment).
      const matchedHistory = searchHistory(userContent);
      const historyBlock = formatHistoryContext(matchedHistory);
      if (historyBlock) {
        content_augmented = userContent + historyBlock;
      }
    }

    // ── Philosophy pull (frame-gated; cadence still applies) ──────────
    // Frame gate is the primary control. Normal periodic philosophy fires
    // only when the frame allows it AND the ~1-in-4 cadence hits. The deep
    // "Rumi" beat (canFireRumi) lets a philosophy moment land outside the
    // cadence on a high-confidence Challenge/Breakthrough with the product
    // question settled — with the rule detector that's Challenge in practice;
    // Breakthrough stays dormant until the Phase 3 classifier.
    // Never on a vibe handoff/safety turn: a redirect (or someone in trouble)
    // must not arrive wearing a philosophy quote.
    const philAllowed = fGate("philosophy", frame, confidence) && !handoff && !vibeSafety && !suppressInjection;
    const rumiBeat = !handoff && !vibeSafety && !suppressInjection && canFireRumi(frame, confidence, isProductSettled(userContent));
    if ((philAllowed && shouldPullPhilosophy(currentCount)) || rumiBeat) {
      const quote = pullPhilosophy(userContent);
      const philBlock = formatPhilosophyContext(quote);
      if (philBlock) {
        content_augmented = (content_augmented || userContent) + philBlock;
      }
    }

    // ── Assemble messages array for AI ────────────────────────────────
    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: content_augmented || userContent },
    ];

    // ── Call AI endpoint (one retry on a blank return) ────────────────
    // The in-character "I just blanked" line was masking flaky returns: an
    // empty/all-scaffold completion went straight to the costume with no
    // second attempt. Now every blank return is logged raw AND retried once
    // before the fallback ships.
    let attempt = await callChatModel(aiMessages);
    if (!attempt.ok) {
      console.error("AI API error:", attempt.status, attempt.errBody);
      return errorResponse(502, "AI service unavailable");
    }

    let { reply, rawContent, finishReason, aiData } = attempt;
    if (!reply) {
      console.error(
        "chat blank return (retrying once):",
        JSON.stringify({
          tab,
          topic,
          finish_reason: finishReason,
          raw_len: rawContent.length,
          raw_preview: rawContent.slice(0, 300),
        })
      );
      const retry = await callChatModel(aiMessages);
      if (retry.ok && retry.reply) {
        ({ reply, rawContent, finishReason, aiData } = retry);
      } else if (retry.ok) {
        console.error(
          "chat blank-fallback (retry also blank):",
          JSON.stringify({
            tab,
            topic,
            finish_reason: retry.finishReason,
            raw_len: retry.rawContent.length,
            raw_preview: retry.rawContent.slice(0, 300),
          })
        );
      } else {
        console.error(
          "chat blank-fallback (retry HTTP error):",
          retry.status,
          retry.errBody
        );
      }
    }
    if (!reply) {
      // The fixed replies are no longer the normal path (Addendum B1), but
      // they remain the FLOOR for exactly this case: the model returned
      // nothing on a safety turn. "hey bro... I'm kinda tapped for today" is
      // not an acceptable answer to someone in crisis, and a provider outage
      // is not a reason for the layer to go quiet.
      reply = safetyMode === "crisis" ? CRISIS_REPLY
        : safetyMode === "substance"
          ? (substanceHit.tier === 2 ? SUBSTANCE_REPLY_S2 : SUBSTANCE_REPLY_S1)
          : BLANK_REPLY_FALLBACK;
      if (safetyMode) {
        console.error("safety turn fell back to fixed text:", JSON.stringify({
          thread_id, mode: safetyMode,
        }));
      }
    } else if (finishReason === "length") {
      // Answer was cut mid-sentence ("You mean to…"): the model spent its
      // output budget on hidden reasoning/scaffold before the real reply.
      // Log the TAIL too, so the truncation traces to what actually got cut.
      console.warn(
        "chat truncated (finish_reason=length):",
        JSON.stringify({
          tab,
          topic,
          raw_len: rawContent.length,
          reply_len: reply.length,
          raw_tail: rawContent.slice(-120),
        })
      );
    }
    const tokens_in = aiData.usage?.prompt_tokens || 0;
    const tokens_out = aiData.usage?.completion_tokens || 0;

    // ── Store user message ────────────────────────────────────────────
    // content = what the user sees (raw message)
    // content_augmented = message + strain/philosophy context (plant tab)
    await supabaseAdmin.from("messages").insert({
      thread_id,
      role: "user",
      content: userContent,
      content_augmented: content_augmented || null,
      tokens_in: 0,
      tokens_out: 0,
    });

    // ── Store assistant response ──────────────────────────────────────
    await supabaseAdmin.from("messages").insert({
      thread_id,
      role: "assistant",
      content: reply,
      content_augmented: null,
      tokens_in,
      tokens_out,
    });

    // ── Update thread timestamp ───────────────────────────────────────
    await supabaseAdmin
      .from("threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", thread_id);

    // ── Post-response work → background function ─────────────────────
    // Title, session memory, consolidation, and the conversational strain
    // save run in api/chat-postwork-background.js — a sync Lambda freezes at
    // return, so detached promises here are lost/deferred. The await below is
    // only the 202 handshake (~100ms), not the work. The background function
    // re-derives everything from the DB, which is authoritative because both
    // messages were inserted above.
    //
    // SKIPPED ENTIRELY ON A SAFETY TURN. Under Addendum B these turns reach
    // the model like any other, so all three of the Doc 3a exemptions would
    // have silently come back on unless they were re-applied here. Decided
    // deliberately (probe C1): "user was suicidal on Aug 5" must never be
    // written into a memory profile and surfaced cheerfully three weeks later
    // in a casual conversation. Title generation is suppressed with it — a
    // thread titled after someone's worst night sits in their sidebar forever.
    if (!safetyMode) {
      try {
        await fetch(
          `${process.env.URL}/.netlify/functions/chat-postwork-background`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-secret": process.env.INTERNAL_TASK_SECRET,
            },
            body: JSON.stringify({ user_id, thread_id, tab }),
          }
        );
      } catch (e) {
        console.error("postwork invoke failed (non-blocking):", e.message);
      }
    }

    // ── Increment usage counter ───────────────────────────────────────
    // Write-side daily reset: if new day, set to 1; otherwise increment.
    // A safety turn does not cost a message, even though it now costs a real
    // model call. That is an accepted cost.
    const newCount = safetyMode
      ? currentCount
      : user.last_message_date !== today ? 1 : currentCount + 1;

    if (!safetyMode) {
      await supabaseAdmin
        .from("users")
        .update({
          daily_message_count: newCount,
          last_message_date: today,
        })
        .eq("id", user_id);
    }

    // ── Retention instrumentation (append-only, per-user per-day) ─────
    // Counts for EVERYONE, founders included — like the counter above, the
    // founder check skips the limit, not the increment. Dashboards exclude
    // internal accounts via users.is_internal, not by skipping the write.
    // Non-blocking: a metrics miss must never fail a chat message.
    //
    // Not on a safety turn. Someone's worst night is not a DAU.
    if (!safetyMode) {
      const { error: activityError } = await supabaseAdmin.rpc("bump_activity_day", {
        p_user_id: user_id,
        p_day: today,
      });
      if (activityError) {
        console.error("bump_activity_day failed (non-blocking):", activityError.message);
      }
    }

    // ── Calculate usage_remaining ─────────────────────────────────────
    // null if unlimited (founder or subscribed), integer if free tier.
    // Counting still happens for everyone (harmless); it's just never
    // enforced against founders.
    const usage_remaining = unlimited
      ? null
      : Math.max(0, FREE_DAILY_LIMIT - newCount);

    // ── Response ──────────────────────────────────────────────────────
    // handoff drives the UI's click-over button — the client must gate on
    // this flag, never on string-matching the reply prose.
    //
    // safetyCard is attached HERE, in code, after the model has returned. That
    // is where the guarantee lives now: no prompt injection talks a UI
    // component off a screen.
    //
    // FALLBACK: a client that didn't send supports_safety_card is an old
    // cached bundle that will not render the field, so the resource is
    // appended to the text instead. A frontend deploy failure must not
    // silently remove the disclosure.
    const safetyCard = buildSafetyCard(cardKind);
    const clientRenders = body.supports_safety_card === true;
    const replyOut =
      safetyCard && !clientRenders ? appendCardFallback(reply, cardKind) : reply;

    return jsonResponse(200, {
      reply: replyOut,
      tokens_in,
      tokens_out,
      usage_remaining,
      handoff, // "plant" | null
      handoff_message: handoff ? userContent : null, // carried into the new thread
      safetyCard, // object | null — rendered below the message by the client
    });
  } catch (err) {
    console.error("chat/send error:", err);
    return errorResponse(500, "Internal server error");
  }
}

// ── Chat completion call (shared by first attempt + blank retry) ───
// Returns { ok:false, status, errBody } on HTTP failure, else
// { ok:true, reply, rawContent, finishReason, aiData }. `reply` is the
// sanitized text — "" when the return was blank/pure scaffold.
async function callChatModel(aiMessages) {
  const aiData = await openrouterChat(AI_MODEL_CHAT, aiMessages, {
    temperature: AI_TEMPERATURE,
    max_tokens: MAX_TOKENS,
    // Kill reasoning at the source: the hidden <think>/<ds_safety>
    // scaffold was eating the output budget (truncation, blank replies)
    // before the real answer. The sanitizer stays as a backstop for
    // providers that ignore this.
    reasoning: { enabled: false },
    // Reduce within-response repetition / stock signature lines.
    // NOTE: these only affect a single response, not across requests —
    // the prompt instruction in prompts/plant.js is the cross-session
    // fix. Some OpenRouter providers ignore unsupported params silently.
    frequency_penalty: 0.4,
    presence_penalty: 0.3,
  }, {
    // Synchronous path: Netlify kills this function at 10s, so the
    // per-attempt timeout has to leave room for the cross-model retry
    // inside that budget. Background callers keep the longer default.
    timeoutMs: OPENROUTER_TIMEOUT_CHAT_MS,
  });

  if (!aiData) {
    return { ok: false, status: 0, errBody: "openrouter request failed" };
  }

  const choice = aiData.choices?.[0];
  const finishReason = choice?.finish_reason || null;
  // Strip any leaked model scaffolding (<think>, <ds_safety>, stray XML-ish
  // tags) before it ever reaches storage or the user.
  const rawContent = choice?.message?.content || "";
  let reply = stripModelTags(rawContent);
  if (!reply && rawContent.trim()) {
    // Sanitizing emptied a non-empty response (e.g. the model put the whole
    // answer inside a <think> block). Recover the words by dropping only the
    // tag tokens — a slightly-raw answer beats a blank "I just blanked."
    reply = rawContent
      .replace(/<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return { ok: true, reply, rawContent, finishReason, aiData };
}
