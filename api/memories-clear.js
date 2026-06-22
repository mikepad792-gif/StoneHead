// api/memories-clear.js
// StoneHead — Clear session memories (Phase 2, Section 6)
//
// POST /api/memories/clear
// Body (optional): { memory_id }  — delete one; omit to clear all
// Auth: authenticateRequest (Thread 1 pattern)
//
// Lets the user wipe what Stone Head remembers. Always scoped to the
// authenticated user_id (the service-role client bypasses RLS, so the scope is
// enforced here in code, same as the rest of the server).

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
  const { memory_id } = body;

  try {
    let query = supabaseAdmin
      .from("session_memories")
      .delete()
      .eq("user_id", user_id); // always scope to the authenticated user

    if (memory_id) {
      query = query.eq("id", memory_id); // delete just this one
    }

    const { error } = await query;
    if (error) {
      return errorResponse(500, "Failed to clear memories");
    }

    return jsonResponse(200, { cleared: true, scope: memory_id ? "one" : "all" });
  } catch (err) {
    console.error("memories/clear error:", err);
    return errorResponse(500, "Internal server error");
  }
}
