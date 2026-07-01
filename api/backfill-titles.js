// api/backfill-titles.js
// StoneHead — One-off thread-title backfill (Phase 2, Section 0)
//
// POST /api/backfill-titles
// Header: x-backfill-secret: <CALLBACK_SECRET>
//
// Fixes the Phase 1 gap where the backfill matched only "new vibe" and skipped
// plant threads ("new plant chat") and the original DB default ("New Thread").
// Sweeps every thread still on a default name with >= 2 messages and regenerates
// a TOPIC-PHRASE title (not a conversational fragment).
//
// Processes up to BATCH per call to stay inside the function timeout — the
// response reports `remaining`, so hit it again until remaining is 0. Delete
// this file once the backlog is cleared.
//
// NOTE for Claude Code: mirror TITLE_SYSTEM_PROMPT below into the live
// generateThreadTitle() in chat-send.js so new titles match this quality.

import { errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { stripModelTags } from "../lib/sanitize.js";

const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL =
  process.env.AI_MODEL || "nousresearch/hermes-3-llama-3.1-405b:free";

// All default titles a thread can still be sitting on.
const DEFAULT_TITLES = ["New Thread", "new vibe", "new plant chat"];

const BATCH = 12; // threads per invocation

export const TITLE_SYSTEM_PROMPT =
  "Create a 3-5 word topic title for this conversation. Use a short noun " +
  "phrase that names the subject. Do NOT use a sentence, a question, or a " +
  "fragment of what someone said. No quotes, no punctuation, no first person. " +
  "Good: Northern Lights for sleep. Bad: If youre looking for. Bad: Does that make sense.";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  // Simple admin gate — must present the callback secret.
  const provided =
    event.headers?.["x-backfill-secret"] ||
    event.headers?.["X-Backfill-Secret"];
  if (!process.env.CALLBACK_SECRET || provided !== process.env.CALLBACK_SECRET) {
    return errorResponse(401, "Unauthorized");
  }

  try {
    // Find default-named threads, oldest first.
    const { data: threads, error } = await supabaseAdmin
      .from("threads")
      .select("id, title")
      .in("title", DEFAULT_TITLES)
      .order("created_at", { ascending: true })
      .limit(BATCH + 1); // peek one extra to compute `remaining`

    if (error) {
      return errorResponse(500, "Failed to load threads");
    }

    const batch = (threads || []).slice(0, BATCH);
    let updated = 0;
    let skipped = 0;

    for (const thread of batch) {
      // Need at least 2 messages to title meaningfully.
      const { data: msgs } = await supabaseAdmin
        .from("messages")
        .select("role, content")
        .eq("thread_id", thread.id)
        .order("created_at", { ascending: true })
        .limit(4);

      if (!msgs || msgs.length < 2) {
        skipped++;
        continue;
      }

      const title = await generateTopicTitle(msgs);
      if (!title) {
        skipped++;
        continue;
      }

      await supabaseAdmin
        .from("threads")
        .update({ title })
        .eq("id", thread.id);
      updated++;
    }

    const remaining = Math.max(0, (threads?.length || 0) - batch.length);

    return jsonResponse(200, {
      processed: batch.length,
      updated,
      skipped,
      remaining, // call again until this is 0
    });
  } catch (err) {
    console.error("backfill-titles error:", err);
    return errorResponse(500, "Internal server error");
  }
}

async function generateTopicTitle(msgs) {
  try {
    const convo = msgs
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 1500);

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
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          { role: "user", content: convo },
        ],
        max_tokens: 15,
        temperature: 0.3,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    let title = data.choices?.[0]?.message?.content;
    // Backstop: strip any leaked tags/scaffolding before cleanup.
    title = stripModelTags(title).replace(/["']/g, "").replace(/[.?!]+$/, "").slice(0, 60).trim();
    return title || null;
  } catch (e) {
    console.error("generateTopicTitle error:", e.message);
    return null;
  }
}
