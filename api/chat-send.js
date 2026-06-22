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
import { FREE_DAILY_LIMIT } from "../lib/constants.js";
import { VIBE_PROMPT } from "../prompts/vibe.js";
import { buildPlantPrompt } from "../prompts/plant.js";
import { searchStrains, formatStrainContext } from "../lib/strainSearch.js";
import {
  shouldPullPhilosophy,
  pullPhilosophy,
  formatPhilosophyContext,
} from "../lib/philosophyPull.js";
import { searchHistory, formatHistoryContext } from "../lib/historySearch.js";
import { detectSaveIntent } from "../lib/saveIntent.js";
import { addLikedStrain } from "../lib/likedStrains.js";

// ─── AI Configuration ───────────────────────────────────────────────
// Cheapest viable model via OpenRouter. Stone Head doesn't need to be
// too smart — the system prompt is the soul, the model is the mouth.
const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "nousresearch/hermes-3-llama-3.1-405b:free";
const AI_TEMPERATURE = 0.75;
// Max reply length for the main completion. Env-tunable like AI_MODEL.
// 250 gives deep convos room to finish thoughts without truncating.
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 250;

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

    // ── Build system prompt ───────────────────────────────────────────
    let systemPrompt;

    if (tab === "plant") {
      // Fetch user's liked strains for context injection
      const { data: liked_strains } = await supabaseAdmin
        .from("liked_strains")
        .select("strain_name, strain_type, notes")
        .eq("user_id", user_id);

      systemPrompt = buildPlantPrompt(liked_strains || []);
    } else {
      systemPrompt = VIBE_PROMPT;
    }

    // ── Build user message (with augmentation for plant tab) ──────────
    let userContent = message.trim();
    let content_augmented = null;

    if (tab === "plant") {
      // Strain retrieval: only fires when user mentions a strain by name
      const matchedStrains = searchStrains(userContent);
      const strainBlock = formatStrainContext(matchedStrains);

      if (strainBlock) {
        content_augmented = userContent + strainBlock;
      }

      // History retrieval: fires on inject_trigger matches
      const matchedHistory = searchHistory(userContent);
      const historyBlock = formatHistoryContext(matchedHistory);

      if (historyBlock) {
        if (content_augmented) {
          content_augmented += historyBlock;
        } else {
          content_augmented = userContent + historyBlock;
        }
      }
    }

    // ── Philosophy pull (both tabs, periodic) ─────────────────────────
    if (shouldPullPhilosophy(currentCount)) {
      const quote = pullPhilosophy(userContent);
      const philBlock = formatPhilosophyContext(quote);

      if (philBlock) {
        if (content_augmented) {
          content_augmented += philBlock;
        } else {
          content_augmented = userContent + philBlock;
        }
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
    const reply = choice?.message?.content || "...bro I just blanked. say that again?";
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
    // "new vibe" threads on their next message.
    const DEFAULT_TITLES = ["new vibe", "new plant chat", "new thread"];
    const isDefaultTitle =
      !thread.title ||
      DEFAULT_TITLES.includes(thread.title.trim().toLowerCase());

    if (history.length === 0 || (isDefaultTitle && history.length >= 2)) {
      generateThreadTitle(thread_id, userContent, reply).catch((e) =>
        console.error("Title generation failed (non-blocking):", e)
      );
    }

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
            role: "system",
            content:
              "Give this conversation a 3-5 word TOPIC title, like a headline or a note's filename. " +
              "Name the subject, not a sentence from the chat. " +
              "No quotes, no punctuation, no greetings, no conversational fragments. " +
              'Good: "Indica for sleep", "Weekend hiking strains", "Dealing with stress". ' +
              'Bad: "Does that make sense", "Hey what is up". ' +
              "Output only the title.",
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
    let title = data.choices?.[0]?.message?.content?.trim();
    if (!title) return;

    // Clean up: remove quotes, limit length
    title = title.replace(/["']/g, "").slice(0, 60);

    await supabaseAdmin
      .from("threads")
      .update({ title })
      .eq("id", threadId);
  } catch (e) {
    // Non-critical — log and move on
    console.error("Title gen error:", e.message);
  }
}
