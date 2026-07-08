// api/profile/username-update.js
// POST /api/profile/username-update
//
// Requires: Authorization: Bearer <session_token>
//
// Request fields:
//   username — string (the new username, 2-30 chars, same rules as register)
//
// Response:
//   username — string (the saved username)
//
// Uniqueness: checked against other users before writing (same shape as
// auth-register's check), with the users.username UNIQUE constraint as the
// backstop — if two renames race, the second insert-time violation is
// mapped to the same 409 the pre-check would have given.

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

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  // --- Validate (same rules as auth-register, plus trim) ---
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!username) {
    return errorResponse(400, "username is required");
  }
  if (username.length < 2 || username.length > 30) {
    return errorResponse(400, "username must be 2-30 characters");
  }

  // --- Check username uniqueness (excluding self, so a same-name save is a no-op) ---
  const { data: existingUser, error: checkError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("username", username)
    .neq("id", user_id)
    .maybeSingle();

  if (checkError) {
    return errorResponse(500, "Failed to check username");
  }
  if (existingUser) {
    return errorResponse(409, "username already taken");
  }

  // --- Update ---
  const { error: updateError } = await supabaseAdmin
    .from("users")
    .update({ username })
    .eq("id", user_id);

  if (updateError) {
    // 23505 = unique_violation: someone claimed the name between the check
    // and the write. Same answer as the pre-check, just later.
    if (updateError.code === "23505") {
      return errorResponse(409, "username already taken");
    }
    return errorResponse(500, "Failed to update username");
  }

  return jsonResponse(200, { username });
}
