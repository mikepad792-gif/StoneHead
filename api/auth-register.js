// api/auth/register.js
// POST /api/auth/register
//
// Request fields (MASTER_TERMS.md):
//   email      — string
//   password   — string
//   username   — string
//
// Response fields (MASTER_TERMS.md):
//   user_id       — string (uuid)
//   session_token — string

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

  const { email, password, username } = body;

  // --- Validate required fields ---
  if (!email || typeof email !== "string") {
    return errorResponse(400, "email is required");
  }
  if (!password || typeof password !== "string") {
    return errorResponse(400, "password is required");
  }
  if (!username || typeof username !== "string") {
    return errorResponse(400, "username is required");
  }
  if (password.length < 8) {
    return errorResponse(400, "password must be at least 8 characters");
  }
  if (username.length < 2 || username.length > 30) {
    return errorResponse(400, "username must be 2-30 characters");
  }

  // --- Check username uniqueness ---
  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (existingUser) {
    return errorResponse(409, "username already taken");
  }

  // --- Create Supabase Auth user ---
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email,
    password,
  });

  if (authError) {
    // Supabase returns a generic message for duplicate emails
    if (authError.message?.includes("already registered")) {
      return errorResponse(409, "email already registered");
    }
    return errorResponse(400, authError.message);
  }

  const user_id = authData.user.id;

  // --- Guard: session must exist ---
  // MASTER_TERMS.md defines session_token as a string in the register response.
  // If Supabase Auth has email confirmation enabled, authData.session is null
  // and we cannot fulfill the contract. Fail explicitly rather than returning
  // a null token that breaks every downstream consumer.
  //
  // Fix: Supabase Dashboard → Authentication → Providers → Email →
  //       disable "Confirm email"
  if (!authData.session?.access_token) {
    // Clean up the auth user we just created — can't leave a half-registered account
    await supabaseAdmin.auth.admin.deleteUser(user_id);
    return errorResponse(500,
      "Registration failed: no session returned. " +
      "Supabase email confirmation must be disabled for StoneHead."
    );
  }

  const session_token = authData.session.access_token;

  // --- Insert row into users table ---
  // password_hash is handled by Supabase Auth internally.
  // We store a placeholder in our users table since Supabase Auth
  // manages the actual hash. The column exists per MASTER_TERMS.md.
  const { error: insertError } = await supabaseAdmin.from("users").insert({
    id: user_id,
    email,
    username,
    password_hash: "managed_by_supabase_auth",
    is_subscribed: false,
    subscription_expires: null,
    age_verified: false,
    daily_message_count: 0,
    last_message_date: null,
  });

  if (insertError) {
    // Rollback: delete the auth user if profile insert fails
    await supabaseAdmin.auth.admin.deleteUser(user_id);
    return errorResponse(500, "Account creation failed: " + insertError.message);
  }

  // --- Return MASTER_TERMS.md response fields ---
  return jsonResponse(201, {
    user_id,
    session_token,
  });
}
