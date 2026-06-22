// api/core-memories-get.js
// StoneHead — Core memories for the /memory page (Phase 2.5)
//
// GET /api/core-memories/get
// Auth: authenticateRequest (Thread 1 pattern)
//
// Returns the user's active core memories, split by where they render:
//   pinned  -> pinned = true            (the user marked these; permanent)
//   core    -> pinned = false, active   (reflection surfaced these)
// Superseded rows are hidden from the page (kept in the table for traceability).

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }
  const { user_id } = auth;

  try {
    const { data, error } = await supabaseAdmin
      .from("core_memories")
      .select("id, text, why_it_carries, pinned, source, created_at, last_reaffirmed_at")
      .eq("user_id", user_id)
      .eq("status", "active")
      .order("last_reaffirmed_at", { ascending: false });

    if (error) {
      return errorResponse(500, "Failed to load core memories");
    }

    const rows = data || [];
    const pinned = rows.filter((r) => r.pinned);
    const core = rows.filter((r) => !r.pinned);

    return jsonResponse(200, { pinned, core });
  } catch (err) {
    console.error("core-memories/get error:", err);
    return errorResponse(500, "Internal server error");
  }
}
