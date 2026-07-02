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
// Title generation lives in lib/titleGen.js, shared with the live path in
// chat-send.js — one prompt, one validator, one input shape for both.

import { errorResponse, jsonResponse, safeEqual } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { generateTopicTitle } from "../lib/titleGen.js";
import { DEFAULT_TITLES } from "../lib/constants.js";

const BATCH = 12; // threads per invocation

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  // Simple admin gate — must present the callback secret.
  const provided =
    event.headers?.["x-backfill-secret"] ||
    event.headers?.["X-Backfill-Secret"];
  if (!process.env.CALLBACK_SECRET || !safeEqual(provided, process.env.CALLBACK_SECRET)) {
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
