// api/auth-reset-password.js
// POST /api/auth/reset-password
//
// Consumes the recovery token from the emailed link and sets a new password.
//
// Supabase verifies the token on its own domain first, then redirects to
// /reset with the tokens in the URL HASH:
//
//   https://stoneheadai.com/reset#access_token=eyJ...&type=recovery&...
//
// The hash never reaches the server (browsers don't send it), so the page
// reads it in JS and posts the token here.
//
// Request fields:
//   access_token — string (from the recovery hash)
//   password     — string (the new password)
//
// Response fields:
//   ok — boolean

import { supabase, supabaseAdmin } from "../lib/supabase.js";
import { errorResponse, jsonResponse } from "../lib/auth.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const access_token = String(body.access_token || "");
  const password = String(body.password || "");

  if (!access_token) return errorResponse(400, "Missing reset token");

  // Same minimum as api/auth-register.js. Do not invent a different rule
  // here — a reset that accepts a weaker password than signup does is a
  // silent downgrade path.
  if (password.length < 8) {
    return errorResponse(400, "password must be at least 8 characters");
  }

  // Validate the recovery token and find out who it belongs to.
  const { data: userData, error: getErr } =
    await supabase.auth.getUser(access_token);

  if (getErr || !userData?.user) {
    return errorResponse(401, "That reset link expired or was already used");
  }

  const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(
    userData.user.id,
    { password }
  );

  if (updErr) {
    console.warn("reset-password:", updErr.message);
    return errorResponse(500, "Couldn't update the password");
  }

  // public.users.password_hash holds the literal string
  // "managed_by_supabase_auth" (see api/auth-register.js) — Supabase Auth owns
  // the real hash, so there is nothing to update there. Leave it alone.
  return jsonResponse(200, { ok: true });
}
