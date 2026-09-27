// GET /api/threads/messages
// Query params: thread_id
// Response: { messages: [{ id, role, content, tokens_in, tokens_out, created_at, photo?, rateable?, rating? }] }
// rateable / rating: thumbs up/down on replies (migration 017). rating is
// "up" | "down" | null, this user's current rating of that reply.
// Note: content_augmented is never sent to frontend
// photo: true marks a user message that was sent with a photo (Talk the
// Plant). The photo itself is never stored, so this is all the UI can show.

import { authenticateRequest } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { detectCrisis } from "../lib/crisisDetect.js";
import { detectSubstance } from "../lib/substanceDetect.js";
import { buildSafetyCard } from "../lib/safetyCard.js";
import { rateableReplyIds } from "../lib/feedbackEligibility.js";

/**
 * Re-derive safety cards for a loaded thread (Addendum B1).
 *
 * Cards attach to every assistant message while the state is active, so
 * reopening a thread must not lose them — otherwise the floor exists only for
 * as long as the tab stays open. Replays the thread forward and attaches a
 * card to each assistant reply whose preceding user turn was in state.
 */
function attachSafetyCards(messages) {
  const history = [];
  let pendingCard = null;

  return messages.map((m) => {
    if (m.role === "user") {
      const crisis = detectCrisis(m.content, history);
      const substance = detectSubstance(m.content);
      pendingCard =
        crisis.tier === 2 ? "crisis"
        : substance.tier === 2 ? "substance_s2"
        : substance.tier === 1 ? "substance_s1"
        : null;
      history.push({ role: "user", content: m.content });
      return m;
    }
    const card = buildSafetyCard(pendingCard);
    pendingCard = null;
    history.push({ role: "assistant", content: m.content });
    return card ? { ...m, safetyCard: card } : m;
  });
}

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const user = await authenticateRequest(event);
    if (user.error) {
      return jsonResponse(user.status || 401, { error: user.error });
    }

    const thread_id = event.queryStringParameters?.thread_id;
    if (!thread_id) {
      return jsonResponse(400, { error: "thread_id is required" });
    }

    // Verify thread belongs to user
    const { data: thread, error: threadErr } = await supabaseAdmin
      .from("threads")
      .select("id, user_id")
      .eq("id", thread_id)
      .single();

    if (threadErr || !thread) {
      return jsonResponse(404, { error: "Thread not found" });
    }

    if (thread.user_id !== user.user_id) {
      return jsonResponse(403, { error: "Not your thread" });
    }

    // NOTE ON CARDS: they are re-derived below rather than stored. The
    // detectors are pure, so replaying the thread reproduces exactly what the
    // live call attached — and it means a change to the cue lists or the card
    // content applies retroactively to open threads instead of leaving stale
    // resources frozen in old rows.

    // Fetch messages — exclude content_augmented (backend-only field)
    const { data: messages, error } = await supabaseAdmin
      .from("messages")
      .select("id, role, content, tokens_in, tokens_out, created_at")
      .eq("thread_id", thread_id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Which messages came with a photo. Its own query against photo_reads
    // (migration 015) rather than a column on messages, and non-blocking:
    // if the photo lookup fails the thread still loads, just without the
    // photo markers. Photos must never be able to take a thread down.
    //
    // The reply ratings (migration 017) are read alongside, and are just as
    // non-blocking: a failure loses the filled-in thumbs, never the thread.
    let photoIds = new Set();
    const [{ data: photoRows, error: photoError }, { data: ratingRows, error: ratingError }] =
      await Promise.all([
        supabaseAdmin
          .from("photo_reads")
          .select("message_id")
          .eq("thread_id", thread_id)
          .not("message_id", "is", null),
        supabaseAdmin
          .from("message_feedback")
          .select("message_id, rating")
          .eq("thread_id", thread_id)
          .eq("user_id", user.user_id),
      ]);
    if (photoError) {
      console.error("threads/messages photo lookup failed (non-blocking):", photoError.message);
    } else {
      photoIds = new Set((photoRows || []).map((r) => r.message_id));
    }
    if (ratingError) {
      console.error("threads/messages rating lookup failed (non-blocking):", ratingError.message);
    }
    const ratings = new Map((ratingRows || []).map((r) => [r.message_id, r.rating]));
    const rateable = rateableReplyIds(messages || []);
    const marked = (messages || []).map((m) => {
      let out = photoIds.has(m.id) ? { ...m, photo: true } : m;
      if (m.role === "assistant") {
        out = { ...out, rateable: rateable.has(m.id), rating: ratings.get(m.id) || null };
      }
      return out;
    });

    return jsonResponse(200, { messages: attachSafetyCards(marked) });
  } catch (err) {
    console.error("threads/messages error:", err);
    return jsonResponse(500, { error: "Failed to load messages" });
  }
}
