// api/profile/age-verify.js
// POST /api/profile/age-verify
//
// Requires: Authorization: Bearer <session_token>
//
// No request body needed — this is a one-way flag set.
// Sets age_verified = true on the authenticated user's profile.
//
// Response:
//   age_verified — boolean (always true on success)

import { supabaseAdmin } from "../lib/supabase.js";
import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  // --- Authenticate ---
  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  // --- Update age_verified ---
  const { error: updateError } = await supabaseAdmin
    .from("users")
    .update({ age_verified: true })
    .eq("id", user_id);

  if (updateError) {
    return errorResponse(500, "Failed to update age_verified");
  }

  // --- Return confirmation ---
  return jsonResponse(200, {
    age_verified: true,
  });
}
