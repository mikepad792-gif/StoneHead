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
import { FREE_DAILY_LIMIT, DEFAULT_TITLES } from "../lib/constants.js";
import { VIBE_PROMPT } from "../prompts/vibe.js";
import { buildPlantPrompt } from "../prompts/plant.js";
import { searchStrains, formatStrainContext, parseConstraints, suggestStrainCorrection } from "../lib/strainSearch.js";
import {
  shouldPullPhilosophy,
  pullPhilosophy,
  formatPhilosophyContext,
} from "../lib/philosophyPull.js";
import { searchHistory, formatHistoryContext } from "../lib/historySearch.js";
import { detectSaveIntent } from "../lib/saveIntent.js";
import { addLikedStrain } from "../lib/likedStrains.js";
import { lookupExtras, formatExtrasBlock } from "../lib/extrasLookup.js";
import { detectFrame, isProductSettled, classifyTopic } from "../lib/frameDetect.js";
import { retrieveCultivation, buildCultivationContext } from "../lib/cultivationSearch.js";
import {
  CULTIVATION_MODE_PROMPT,
  CONSUMPTION_SAFETY_PROMPT,
  AMBIGUOUS_CLARIFIER_PROMPT,
} from "../prompts/cultivation.js";
import { fGate, canFireRumi } from "../lib/fGate.js";
import {
  fetchSessionMemories,
  formatSessionMemoryBlock,
  maybeWriteSessionMemory,
} from "../lib/sessionMemory.js";
import { maybeConsolidate } from "../lib/consolidateMemory.js";
import { stripModelTags } from "../lib/sanitize.js";

// ─── AI Configuration ───────────────────────────────────────────────
// Cheapest viable model via OpenRouter. Stone Head doesn't need to be
// too smart — the system prompt is the soul, the model is the mouth.
const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "nousresearch/hermes-3-llama-3.1-405b:free";
const AI_TEMPERATURE = 0.75;
// Max reply length for the main completion. Env-tunable like AI_MODEL.
// Headroom matters: this model sometimes front-loads hidden reasoning/scaffold
// (<think>/<ds_safety>) that eats the budget and truncates the real answer
// mid-sentence ("You mean to…"). 700 leaves room for reasoning + a full reply;
// the prompt still enforces brevity, so this is a ceiling, not a target.
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 700;

// ─── Limit Message ──────────────────────────────────────────────────
// In-character response when daily limit exceeded. No upsell, no guilt.
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
      .select("daily_message_count, last_message_date, is_subscribed, subscription_expires")
      .eq("id", user_id)
      .single();

    if (userError || !user) {
      return errorResponse(404, "User not found");
    }

    // ── Subscription expiry check ─────────────────────────────────────
    // If is_subscribed is true but subscription_expires is in the past,
    // flip to false in the DB. Catches every lapsed subscription on
    // next message — no scheduled function needed.
    if (user.is_subscribed && user.subscription_expires) {
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

    // Enforce limit for free-tier users
    if (!user.is_subscribed && currentCount >= FREE_DAILY_LIMIT) {
      return jsonResponse(200, {
        reply: LIMIT_MESSAGE,
        tokens_in: 0,
        tokens_out: 0,
        usage_remaining: 0,
      });
    }

    // ── Load thread history (windowed to most recent 20) ──────────────
    // Fetch newest-first with a hard limit so a long thread doesn't send
    // the entire transcript every message, then reverse so the prompt
    // still reads chronologically (oldest → newest).
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

    // ── Frame detection (Phase 2) ─────────────────────────────────────
    // Detect the relational frame once, from the message + recent history.
    // This drives frame-addressed injection (the F Gate) below: content
    // fires when the relational moment is right, not when a keyword matches.
    let userContent = message.trim();
    let content_augmented = null;
    const { frame, confidence } = detectFrame(userContent, history);

    // ── Build system prompt ───────────────────────────────────────────
    let systemPrompt;
    let topic = "STRAIN"; // plant-tab topic route (Cultivation Phase 1)

    if (tab === "plant") {
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
      systemPrompt = buildPlantPrompt(liked_strains);

      // Topic routing (silent — never surfaced as a mode switch). A strain
      // name is only checked when a grow cue is present, to catch the
      // cultivation-about-a-strain fork ("is Blue Dream hard to grow?").
      const growCueQuick = /\b(grow|growing|flower|yield|seedling|clone|harvest|nute|nutrient|soil|coco|hydro|leaf|leaves|droop|yellow|wilt|curl|mold|mildew|rot|pest|mite|thrip|gnat|aphid|root|water|trichome|deficien|lockout|foxtail|hermie)\b/i.test(userContent);
      const hasStrainName = growCueQuick ? searchStrains(userContent).length > 0 : false;
      topic = classifyTopic(userContent, hasStrainName);

      if (topic === "CULTIVATION") systemPrompt += "\n\n" + CULTIVATION_MODE_PROMPT;
      else if (topic === "CONSUMPTION-SAFETY") systemPrompt += "\n\n" + CONSUMPTION_SAFETY_PROMPT;
      else if (topic === "AMBIGUOUS") systemPrompt += "\n\n" + AMBIGUOUS_CLARIFIER_PROMPT;
    } else {
      systemPrompt = VIBE_PROMPT;
    }

    // ── Session memory injection (Phase 2, all frames) ────────────────
    // session_memories is unconditional in the F Gate — Stone Head should
    // always carry what he remembers about this person.
    const memories = await fetchSessionMemories(user_id);
    const memBlock = formatSessionMemoryBlock(memories); // "" if none
    systemPrompt = systemPrompt + memBlock;

    // ── Build user message augmentation (plant tab) ──────────────────
    if (tab === "plant" && topic === "CULTIVATION") {
      // Cultivation reference is injected regardless of the relational frame:
      // someone with a maybe-dying plant needs the facts even in a
      // friction/grounding moment. The clarifying cluster comes from the
      // matched issue's curated confused_with, not a noisy neighbor list.
      const cultBlock = buildCultivationContext(retrieveCultivation(userContent));
      if (cultBlock) content_augmented = userContent + cultBlock;
    } else if (tab === "plant" && topic === "STRAIN") {
      // Strain retrieval — only when the frame allows informative content.
      if (fGate("strain_context", frame, confidence)) {
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
        }

        // Extras (Part B): dab knowledge + slang origins. After strain
        // context, gated the same way (informative content).
        const extrasBlock = formatExtrasBlock(lookupExtras(userContent));
        if (extrasBlock) {
          content_augmented = (content_augmented || userContent) + extrasBlock;
        }
      }

      // History retrieval — gated the same way.
      if (fGate("history", frame, confidence)) {
        const matchedHistory = searchHistory(userContent);
        const historyBlock = formatHistoryContext(matchedHistory);
        if (historyBlock) {
          content_augmented = (content_augmented || userContent) + historyBlock;
        }
      }
    }

    // ── Philosophy pull (frame-gated; cadence still applies) ──────────
    // Frame gate is the primary control. Normal periodic philosophy fires
    // only when the frame allows it AND the ~1-in-4 cadence hits. The deep
    // "Rumi" beat (canFireRumi) lets a philosophy moment land outside the
    // cadence on a high-confidence Challenge/Breakthrough with the product
    // question settled — with the rule detector that's Challenge in practice;
    // Breakthrough stays dormant until the Phase 3 classifier.
    const philAllowed = fGate("philosophy", frame, confidence);
    const rumiBeat = canFireRumi(frame, confidence, isProductSettled(userContent));
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

    // ── Call AI endpoint ──────────────────────────────────────────────
    const aiResponse = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://stoneheadai.com",
        "X-Title": "StoneHead AI",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: aiMessages,
        temperature: AI_TEMPERATURE,
        max_tokens: MAX_TOKENS,
        // Reduce within-response repetition / stock signature lines.
        // NOTE: these only affect a single response, not across requests —
        // the prompt instruction in prompts/plant.js is the cross-session
        // fix. Some OpenRouter providers ignore unsupported params silently.
        frequency_penalty: 0.4,
        presence_penalty: 0.3,
      }),
    });

    if (!aiResponse.ok) {
      const errBody = await aiResponse.text();
      console.error("AI API error:", aiResponse.status, errBody);
      return errorResponse(502, "AI service unavailable");
    }

    const aiData = await aiResponse.json();
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
    if (!reply) {
      // The blank fallback is a silent-failure sink — log the ACTUAL model
      // return (finish_reason + raw preview) so we can tell empty from
      // truncated-all-reasoning instead of guessing.
      console.error(
        "chat blank-fallback:",
        JSON.stringify({
          tab,
          topic,
          finish_reason: finishReason,
          raw_len: rawContent.length,
          raw_preview: rawContent.slice(0, 300),
        })
      );
      reply = "...bro I just blanked. say that again?";
    } else if (finishReason === "length") {
      // Answer was cut mid-sentence ("You mean to…"): the model spent its
      // output budget on hidden reasoning/scaffold before the real reply.
      // Logged (not user-visible) so MAX_TOKENS can be tuned against reality.
      console.warn(
        "chat truncated (finish_reason=length):",
        JSON.stringify({ tab, topic, raw_len: rawContent.length, reply_len: reply.length })
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

    // ── Auto-generate thread title (with lazy retry) ─────────────────
    // Fire-and-forget so the user never waits. Generate on the first
    // exchange; also retry for any thread still stuck on its default name
    // after a couple messages. The retry covers title-gen hiccups (the
    // original fire-and-forget had no fallback) AND backfills pre-existing
    // default-named threads on their next message.
    const defaultsLower = DEFAULT_TITLES.map((t) => t.toLowerCase());
    const isDefaultTitle =
      !thread.title ||
      defaultsLower.includes(thread.title.trim().toLowerCase());

    if (history.length === 0 || (isDefaultTitle && history.length >= 2)) {
      generateThreadTitle(thread_id, userContent, reply).catch((e) =>
        console.error("Title generation failed (non-blocking):", e)
      );
    }

    // ── Write session memory (Phase 2, fire-and-forget) ──────────────
    // Compresses a deep enough thread into a frame-tagged summary. Trips
    // at 8 messages (see sessionMemory.js); the full updated transcript is
    // what the trigger counts, so pass history + this exchange.
    const transcript = [
      ...history,
      { role: "user", content: userContent },
      { role: "assistant", content: reply },
    ];
    maybeWriteSessionMemory({ threadId: thread_id, userId: user_id, tab, transcript })
      .catch((e) =>
        console.error("session memory write failed (non-blocking):", e)
      );

    // ── Memory consolidation (Phase 2.5, fire-and-forget, runs DARK) ──
    // Re-derives core memories from the session log when enough fresh
    // material has arrived. Writes core_memories rows; the /memory page's
    // Core section stays flag-gated off until the output is validated.
    maybeConsolidate({ userId: user_id }).catch((e) =>
      console.error("consolidation failed (non-blocking):", e)
    );

    // ── Conversational save/remember (plant tab, fire-and-forget) ────
    // If the user expressed intent to save a strain they like, fire the
    // write in the background so Stone Head's spoken "I'll remember that"
    // and the profile's LIKED STRAINS actually agree. Cheap prefilter
    // (no LLM); only a real strain-name match triggers a DB write.
    if (tab === "plant") {
      const intent = detectSaveIntent(userContent);
      if (intent && intent.type === "liked_strain") {
        addLikedStrain(
          user_id,
          intent.value.strain_name,
          intent.value.strain_type,
          null
        ).catch((e) =>
          console.error("Liked-strain save failed (non-blocking):", e.message)
        );
      }
    }

    // ── Increment usage counter ───────────────────────────────────────
    // Write-side daily reset: if new day, set to 1; otherwise increment
    const newCount = user.last_message_date !== today ? 1 : currentCount + 1;

    await supabaseAdmin
      .from("users")
      .update({
        daily_message_count: newCount,
        last_message_date: today,
      })
      .eq("id", user_id);

    // ── Calculate usage_remaining ─────────────────────────────────────
    // null if subscribed (unlimited), integer if free tier
    const usage_remaining = user.is_subscribed
      ? null
      : Math.max(0, FREE_DAILY_LIMIT - newCount);

    // ── Response ──────────────────────────────────────────────────────
    return jsonResponse(200, {
      reply,
      tokens_in,
      tokens_out,
      usage_remaining,
    });
  } catch (err) {
    console.error("chat/send error:", err);
    return errorResponse(500, "Internal server error");
  }
}

// ── Thread Title Generator (background, non-blocking) ─────────────
async function generateThreadTitle(threadId, userMessage, assistantReply) {
  try {
    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://stoneheadai.com",
        "X-Title": "StoneHead AI",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            // Mirrored from TITLE_SYSTEM_PROMPT in api/backfill-titles.js so
            // live titles match the backfill's quality. Kept inline (not
            // imported) so the one-off backfill endpoint can be deleted
            // without breaking this path.
            role: "system",
            content:
              "Name this conversation in 3-5 plain English words — a short noun phrase " +
              "that names the subject. Output ONLY the title: no tags, no XML, no angle " +
              "brackets, no preamble, no explanation, no quotes, no punctuation, no first " +
              "person, not a sentence or a question. " +
              "Good: Northern Lights for sleep. Bad: <ds_safety>. Bad: If youre looking for. " +
              "Bad: Does that make sense.",
          },
          { role: "user", content: userMessage },
          { role: "assistant", content: assistantReply },
        ],
        max_tokens: 15,
        temperature: 0.3,
      }),
    });

    if (!res.ok) return;

    const data = await res.json();
    let title = data.choices?.[0]?.message?.content;
    // Backstop: strip any leaked tags/scaffolding, then quotes + length.
    title = stripModelTags(title).replace(/["']/g, "").slice(0, 60).trim();
    if (!title) return; // nothing usable — leave the default rather than store junk

    await supabaseAdmin
      .from("threads")
      .update({ title })
      .eq("id", threadId);
  } catch (e) {
    // Non-critical — log and move on
    console.error("Title gen error:", e.message);
  }
}
