// api/auth/login.js
// POST /api/auth/login
//
// Request fields (MASTER_TERMS.md):
//   email    — string
//   password — string
//
// Response fields (MASTER_TERMS.md):
//   user_id        — string (uuid)
//   session_token  — string
//   username       — string
//   is_subscribed  — boolean
//   age_verified   — boolean

import { supabase, supabaseAdmin } from "../lib/supabase.js";
import { errorResponse, jsonResponse } from "../lib/auth.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { email, password } = body;

  if (!email || typeof email !== "string") {
    return errorResponse(400, "email is required");
  }
  if (!password || typeof password !== "string") {
    return errorResponse(400, "password is required");
  }

  // --- Authenticate with Supabase Auth ---
  const { data: authData, error: authError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (authError) {
    return errorResponse(401, "Invalid email or password");
  }

  const user_id = authData.user.id;
  const session_token = authData.session.access_token;

  // --- Fetch profile from users table ---
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("users")
    .select("username, is_subscribed, age_verified")
    .eq("id", user_id)
    .single();

  if (profileError || !profile) {
    return errorResponse(500, "Failed to load user profile");
  }

  // --- Return MASTER_TERMS.md response fields ---
  return jsonResponse(200, {
    user_id,
    session_token,
    username: profile.username,
    is_subscribed: profile.is_subscribed,
    age_verified: profile.age_verified,
  });
}
