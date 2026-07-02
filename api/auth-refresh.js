// api/auth-refresh.js
// POST /api/auth/refresh
//
// Exchanges a refresh_token for a fresh session. Supabase access tokens
// expire (dashboard default 3600s); without this endpoint the client hard
// logs users out mid-conversation every hour.
//
// Request fields (MASTER_TERMS.md conventions):
//   refresh_token — string
//
// Response fields:
//   session_token — string (new access token)
//   refresh_token — string (Supabase ROTATES refresh tokens — the client
//                   must store this new one; the old one is spent)

import { supabase } from "../lib/supabase.js";
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

  const { refresh_token } = body;
  if (!refresh_token || typeof refresh_token !== "string") {
    return errorResponse(400, "refresh_token is required");
  }

  const { data, error } = await supabase.auth.refreshSession({ refresh_token });

  if (error || !data?.session?.access_token) {
    return errorResponse(401, "Invalid or expired refresh_token");
  }

  return jsonResponse(200, {
    session_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
}
