// api/memories-get.js
// StoneHead — Session memory view (Phase 2, Section 6)
//
// GET /api/memories/get
// Auth: authenticateRequest (Thread 1 pattern)
//
// Returns the authenticated user's stored session memories so the profile modal
// can show a "what Stone Head remembers about you" list. Read-only; pairs with
// memories-clear for deletion. Capture stays separate from the data_opt_in
// training pipeline — this is just visibility into what's stored.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

const VIEW_LIMIT = 20; // most recent N shown in the profile

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }
  const { user_id } = auth;

  try {
    const { data, error } = await supabaseAdmin
      .from("session_memories")
      .select("id, summary, frame_tag, tab, created_at")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(VIEW_LIMIT);

    if (error) {
      return errorResponse(500, "Failed to load memories");
    }

    return jsonResponse(200, { memories: data || [] });
  } catch (err) {
    console.error("memories/get error:", err);
    return errorResponse(500, "Internal server error");
  }
}
