// api/usage/check.js
// GET /api/usage/check
// Returns remaining free messages for the current day.
//
// Response: { daily_message_count, usage_remaining, is_subscribed }
//
// usage_remaining = null if subscribed (unlimited)
// usage_remaining = integer if free tier
//
// Convention: Netlify Functions — export async function handler(event)
// Applies same read-side reset logic as Thread 1's profile/get.js:
// if last_message_date !== today, treat count as 0.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { FREE_DAILY_LIMIT } from "../lib/constants.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  // ── Auth ──────────────────────────────────────────────────────────
  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }
  const { user_id } = auth;

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("daily_message_count, last_message_date, is_subscribed")
      .eq("id", user_id)
      .single();

    if (userError || !user) {
      return errorResponse(404, "User not found");
    }

    // Read-side daily reset: if last_message_date is not today, count is 0
    const today = new Date().toISOString().split("T")[0];
    const daily_message_count =
      user.last_message_date === today ? user.daily_message_count || 0 : 0;

    const usage_remaining = user.is_subscribed
      ? null
      : Math.max(0, FREE_DAILY_LIMIT - daily_message_count);

    return jsonResponse(200, {
      daily_message_count,
      usage_remaining,
      is_subscribed: user.is_subscribed,
    });
  } catch (err) {
    console.error("usage/check error:", err);
    return errorResponse(500, "Internal server error");
  }
}
