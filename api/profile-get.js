// api/profile/get.js
// GET /api/profile/get
//
// Requires: Authorization: Bearer <session_token>
//
// Response fields (MASTER_TERMS.md):
//   user_id              — string (uuid)
//   username             — string
//   email                — string
//   is_subscribed        — boolean
//   subscription_expires — string (ISO timestamp) or null
//   age_verified         — boolean
//   daily_message_count  — integer
//   usage_remaining      — integer or null (null if subscribed)
//   liked_strains        — array of { strain_name, strain_type, notes, added_at }

import { supabaseAdmin } from "../lib/supabase.js";
import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { FREE_DAILY_LIMIT } from "../lib/constants.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  // --- Authenticate ---
  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  // --- Fetch user profile ---
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "id, username, email, is_subscribed, subscription_expires, age_verified, daily_message_count, last_message_date, is_founder, founder_number"
    )
    .eq("id", user_id)
    .single();

  if (userError || !user) {
    return errorResponse(500, "Failed to load user profile");
  }

  // --- Compute daily_message_count with reset logic ---
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let daily_message_count = user.daily_message_count;

  if (user.last_message_date !== today) {
    // Day rolled over — count is effectively 0
    daily_message_count = 0;
  }

  // --- Compute usage_remaining ---
  // Founder wins before subscription logic — a founder is never limited.
  const unlimited = user.is_founder || user.is_subscribed;
  let usage_remaining = null;
  if (!unlimited) {
    usage_remaining = Math.max(0, FREE_DAILY_LIMIT - daily_message_count);
  }

  // --- Fetch liked_strains ---
  const { data: liked_strains, error: strainsError } = await supabaseAdmin
    .from("liked_strains")
    .select("strain_name, strain_type, notes, added_at")
    .eq("user_id", user_id)
    .order("added_at", { ascending: false });

  if (strainsError) {
    return errorResponse(500, "Failed to load liked_strains");
  }

  // --- Return MASTER_TERMS.md response fields ---
  return jsonResponse(200, {
    user_id: user.id,
    username: user.username,
    email: user.email,
    is_subscribed: user.is_subscribed,
    subscription_expires: user.subscription_expires,
    age_verified: user.age_verified,
    daily_message_count,
    usage_remaining,
    is_founder: user.is_founder,
    founder_number: user.founder_number,
    liked_strains: liked_strains || [],
  });
}
