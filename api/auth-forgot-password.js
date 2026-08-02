// api/auth-forgot-password.js
// POST /api/auth/forgot-password
//
// Sends a password-reset email. ALWAYS returns 200, regardless of whether
// the address exists — see the note below.
//
// Request fields:
//   email — string
//
// Response fields:
//   ok — boolean (always true on a well-formed request)
//
// NOTE ON THE HELPERS: jsonResponse/errorResponse live in lib/auth.js in this
// repo (there is no lib/http.js), which is where every other endpoint imports
// them from.

import { supabase } from "../lib/supabase.js";
import { errorResponse, jsonResponse } from "../lib/auth.js";

// The page the recovery link lands on. Must also be in Supabase's
// Authentication → URL Configuration → Redirect URLs allow-list, or Supabase
// silently falls back to the Site URL.
const RESET_REDIRECT =
  (process.env.SITE_URL || "https://stoneheadai.com").replace(/\/+$/, "") + "/reset";

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

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return errorResponse(400, "Enter a valid email");
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: RESET_REDIRECT,
  });

  // Log for our own debugging, but never surface it.
  if (error) console.warn("forgot-password:", error.message);

  // ALWAYS 200. Returning "no account with that email" would turn this
  // endpoint into a free membership oracle — anyone could test addresses
  // against it and learn who has a StoneHead account. That matters more
  // here than in most apps: this is a cannabis app, and account existence
  // is not neutral information about a person.
  return jsonResponse(200, { ok: true });
}
