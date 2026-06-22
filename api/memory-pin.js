// api/memory-pin.js
// StoneHead — Pin / unpin a core memory (Phase 2.5, promote-only v1)
//
// POST /api/memory/pin
// Body: { memory_id, pinned }   pinned=true promotes to Pinned (reflection-
//        immune); pinned=false drops it back to the pool for reflection.
// Auth: authenticateRequest (Thread 1 pattern). Always scoped to user_id.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }
  const { user_id } = auth;

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const { memory_id, pinned } = body;

  if (!memory_id) {
    return errorResponse(400, "memory_id is required");
  }
  if (typeof pinned !== "boolean") {
    return errorResponse(400, "pinned must be a boolean");
  }

  try {
    const { error } = await supabaseAdmin
      .from("core_memories")
      .update({ pinned })
      .eq("id", memory_id)
      .eq("user_id", user_id); // scope to the authenticated user

    if (error) {
      return errorResponse(500, "Failed to update pin");
    }

    return jsonResponse(200, { memory_id, pinned });
  } catch (err) {
    console.error("memory/pin error:", err);
    return errorResponse(500, "Internal server error");
  }
}
