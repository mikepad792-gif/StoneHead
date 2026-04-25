// lib/auth.js
// Auth middleware for StoneHead AI serverless functions.
// Verifies the session_token (Supabase JWT) from the Authorization header.
// Attaches the authenticated user's id as user_id on the context.
//
// Field names match MASTER_TERMS.md:
//   session_token, user_id

import { supabase, supabaseAdmin } from "./supabase.js";

/**
 * Extracts session_token from the Authorization header (Bearer <token>)
 * and verifies it against Supabase Auth.
 *
 * Returns { user_id } on success or { error, status } on failure.
 */
export async function authenticateRequest(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || "";
  const session_token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!session_token) {
    return { error: "Missing or malformed Authorization header", status: 401 };
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(session_token);

  if (error || !user) {
    return { error: "Invalid or expired session_token", status: 401 };
  }

  return { user_id: user.id };
}

/**
 * Helper to send a JSON error response.
 * Works with both Netlify Functions (callback style) and generic (res) style.
 */
export function errorResponse(status, message) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}

/**
 * Helper to send a JSON success response.
 */
export function jsonResponse(status, data) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}
