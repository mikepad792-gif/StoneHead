// api/chat-postwork-background.js
// POST /.netlify/functions/chat-postwork-background  (internal only)
//
// All post-response work for a chat exchange: thread title, session memory,
// consolidation, conversational strain save. The `-background` suffix makes
// Netlify run this async with a 15-minute budget (the caller gets a 202
// immediately) — a sync Lambda freezes the moment its handler resolves, so
// detached promises inside chat-send were lost or deferred to the next thaw.
//
// Auth: header `x-internal-secret` compared timing-safe against
// INTERNAL_TASK_SECRET. Body: { user_id, thread_id, tab } — nothing else.
// Everything is re-derived from the DB, which is authoritative because
// chat-send inserts both messages BEFORE invoking this function.
//
// Idempotency: background functions have at-least-once semantics, so a
// retry may re-run the whole body. That is safe because every step already
// guards itself — the title writes only while the thread still wears a
// default name, maybeWriteSessionMemory checks for an existing row,
// maybeConsolidate gates on last_consolidated_at, and addLikedStrain
// dedupes case-insensitively.

import { errorResponse, jsonResponse, safeEqual } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { DEFAULT_TITLES } from "../lib/constants.js";
import { generateTopicTitle } from "../lib/titleGen.js";
import { maybeWriteSessionMemory } from "../lib/sessionMemory.js";
import { maybeConsolidate } from "../lib/consolidateMemory.js";
import { detectSaveIntent } from "../lib/saveIntent.js";
import { addLikedStrain } from "../lib/likedStrains.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  // ── Internal-secret gate (fail closed) ─────────────────────────────
  const expected = process.env.INTERNAL_TASK_SECRET;
  if (!expected) {
    console.error("INTERNAL_TASK_SECRET env var is not set");
    return errorResponse(500, "Server misconfigured");
  }
  const provided =
    event.headers?.["x-internal-secret"] ||
    event.headers?.["X-Internal-Secret"];
  if (!safeEqual(provided, expected)) {
    return errorResponse(401, "Unauthorized");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const { user_id, thread_id, tab } = body;
  if (!user_id || !thread_id || !tab) {
    return errorResponse(400, "user_id, thread_id and tab are required");
  }

  // ── Load ground truth: thread + last 20 messages (chronological) ───
  const { data: thread } = await supabaseAdmin
    .from("threads")
    .select("id, title")
    .eq("id", thread_id)
    .eq("user_id", user_id)
    .single();
  if (!thread) {
    return errorResponse(404, "Thread not found");
  }

  const { data: recent } = await supabaseAdmin
    .from("messages")
    .select("role, content")
    .eq("thread_id", thread_id)
    .order("created_at", { ascending: false })
    .limit(20);
  const messages = (recent || []).slice().reverse();

  // Each step in its own try/catch — one failure must not stop the rest.

  // ── Title: only while the thread still wears a default name ────────
  try {
    const defaultsLower = DEFAULT_TITLES.map((t) => t.toLowerCase());
    const isDefaultTitle =
      !thread.title ||
      defaultsLower.includes(thread.title.trim().toLowerCase());
    if (isDefaultTitle && messages.length > 0) {
      const title = await generateTopicTitle(messages);
      if (title) {
        await supabaseAdmin
          .from("threads")
          .update({ title })
          .eq("id", thread_id);
      }
    }
  } catch (e) {
    console.error("postwork title failed:", e.message);
  }

  // ── Session memory ──────────────────────────────────────────────────
  try {
    await maybeWriteSessionMemory({
      threadId: thread_id,
      userId: user_id,
      tab,
      transcript: messages,
    });
  } catch (e) {
    console.error("postwork session memory failed:", e.message);
  }

  // ── Consolidation ───────────────────────────────────────────────────
  try {
    await maybeConsolidate({ userId: user_id });
  } catch (e) {
    console.error("postwork consolidation failed:", e.message);
  }

  // ── Conversational strain save (plant tab only) ─────────────────────
  try {
    if (tab === "plant") {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const intent = lastUser ? detectSaveIntent(lastUser.content) : null;
      if (intent && intent.type === "liked_strain") {
        // Trace what the save actually received vs what it derived — this is
        // the line that catches a sentence fragment before it hits the DB.
        console.log(
          "liked-strain save:",
          JSON.stringify({
            received: lastUser.content.slice(0, 160),
            saving: intent.value,
          })
        );
        await addLikedStrain(
          user_id,
          intent.value.strain_name,
          intent.value.strain_type,
          null
        );
      }
    }
  } catch (e) {
    console.error("postwork liked-strain save failed:", e.message);
  }

  return jsonResponse(200, { ok: true });
}
