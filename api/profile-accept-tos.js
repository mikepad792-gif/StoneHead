// api/profile-accept-tos.js
// POST /api/profile/accept-tos
//
// Records that the authenticated user accepted the CURRENT terms and privacy
// policy. One-time per version — see TOS_VERSION in lib/constants.js.
//
// Requires: Authorization: Bearer <session_token>
// No request body. The version is taken from the server, never from the
// client: a client that could name its own version could accept a version
// that was never published.
//
// Response:
//   tos_accepted_at — ISO timestamp
//   tos_version     — the version accepted
//
// THERE IS NO DECLINE ENDPOINT, on purpose. Declining logs the user out on the
// client and writes nothing. Nothing is deleted and nothing is recorded,
// because "this person read the terms and left" is not a fact worth keeping
// about somebody — and it means the decision is fully recoverable: they log
// back in and the modal is waiting.

import { supabaseAdmin } from "../lib/supabase.js";
import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { TOS_VERSION } from "../lib/constants.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status || 401, auth.error);
  }

  const tos_accepted_at = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("users")
    .update({ tos_accepted_at, tos_version: TOS_VERSION })
    .eq("id", auth.user_id);

  if (error) {
    console.error("accept-tos failed:", error.message);
    return errorResponse(500, "Couldn't record that");
  }

  return jsonResponse(200, { tos_accepted_at, tos_version: TOS_VERSION });
}
