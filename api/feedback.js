// POST /api/feedback
// Body: { message_id, rating: "up" | "down" | null, comment?, dont_ask_again? }
// Response: { success: true, rating }
//
// Thumbs up / down on one StoneHead reply (migration 017).
//   up:   training_ok = true. dont_ask_again also sets
//         users.skip_training_prompt so later thumbs-ups skip the dialog.
//   down: training_ok = false.
//   Either thumb takes an optional comment (<= 1000 chars).
//   null: removes this user's rating for the reply.
// Rating a reply is consent to review that one exchange, even in a thread
// with the data toggle off (see reviewable_feedback in 017).
//
// Safety turns can't be rated: the same rule the client uses to hide the
// thumbs (lib/feedbackEligibility.js), so a hand-built request can't either.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { rateableReplyIds } from "../lib/feedbackEligibility.js";
import { APP_VERSION } from "../src/version.js";

export const MAX_COMMENT = 1000;

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const { message_id, rating = null, dont_ask_again = false } = body || {};
  if (!message_id || typeof message_id !== "string") {
    return errorResponse(400, "message_id is required");
  }
  if (rating !== null && rating !== "up" && rating !== "down") {
    return errorResponse(400, 'rating must be "up", "down", or null');
  }
  let comment = null;
  if (rating !== null && body.comment != null) {
    if (typeof body.comment !== "string") return errorResponse(400, "comment must be text");
    comment = body.comment.trim() || null;
    if (comment && comment.length > MAX_COMMENT) {
      return errorResponse(400, `comment must be ${MAX_COMMENT} characters or less`);
    }
  }

  // The reply, its thread, and that it's this user's.
  const { data: message } = await supabaseAdmin
    .from("messages")
    .select("id, thread_id, role")
    .eq("id", message_id)
    .maybeSingle();
  if (!message || message.role !== "assistant") {
    return errorResponse(404, "Reply not found");
  }
  const { data: thread } = await supabaseAdmin
    .from("threads")
    .select("id, user_id")
    .eq("id", message.thread_id)
    .maybeSingle();
  if (!thread || thread.user_id !== user_id) {
    return errorResponse(404, "Reply not found");
  }

  // Replay the thread up to this reply and refuse a safety turn.
  const { data: threadMessages, error: threadError } = await supabaseAdmin
    .from("messages")
    .select("id, role, content, created_at")
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: true });
  if (threadError) {
    console.error("feedback: thread load failed:", threadError.message);
    return errorResponse(500, "couldn't save that. try again in a sec");
  }
  if (!rateableReplyIds(threadMessages).has(message_id)) {
    return errorResponse(409, "This reply can't be rated");
  }

  if (rating === null) {
    const { error } = await supabaseAdmin
      .from("message_feedback")
      .delete()
      .eq("user_id", user_id)
      .eq("message_id", message_id);
    if (error) {
      console.error("feedback: delete failed:", error.message);
      return errorResponse(500, "couldn't save that. try again in a sec");
    }
    console.log(JSON.stringify({ event: "feedback", rating: null }));
    return jsonResponse(200, { success: true, rating: null });
  }

  const { error: upsertError } = await supabaseAdmin
    .from("message_feedback")
    .upsert(
      {
        user_id,
        thread_id: thread.id,
        message_id,
        rating,
        comment,
        training_ok: rating === "up",
        updated_at: new Date().toISOString(),
        // The version they rated on; changing the rating later updates it.
        app_version: APP_VERSION,
      },
      { onConflict: "user_id,message_id" }
    );
  if (upsertError) {
    console.error("feedback: save failed:", upsertError.message);
    return errorResponse(500, "couldn't save that. try again in a sec");
  }

  if (rating === "up" && dont_ask_again === true) {
    const { error } = await supabaseAdmin
      .from("users")
      .update({ skip_training_prompt: true })
      .eq("id", user_id);
    // The rating is saved either way; the dialog just shows again next time.
    if (error) console.error("feedback: skip_training_prompt failed:", error.message);
  }

  // Never the comment text.
  console.log(JSON.stringify({ event: "feedback", rating }));
  return jsonResponse(200, { success: true, rating });
}
