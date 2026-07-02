// api/memory-pin.js
// StoneHead — Pin / unpin a core memory (Phase 2.5, promote-only v1)
//
// POST /api/memory/pin
// Two modes (both authenticated, always scoped to user_id):
//   1. Toggle an existing core memory:   { memory_id, pinned }
//      pinned=true → Pinned (reflection-immune); false → back to the pool.
//   2. Promote a session memory to Pinned: { summary, source_session_id }
//      Creates a user-sourced, pinned core_memory. This is how a user pins
//      something at launch, before the (dark) consolidation job has produced
//      any reflection core memories.

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
  const { memory_id, pinned, summary, source_session_id } = body;

  try {
    // Mode 2 — promote a session memory into a pinned core memory.
    if (summary && typeof summary === "string" && summary.trim()) {
      // Cap pinned rows — they're permanent (reflection-immune) and feed the
      // consolidation prompt, so unbounded inserts are both storage and
      // prompt-stuffing surface.
      const { count: pinnedCount } = await supabaseAdmin
        .from("core_memories")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user_id)
        .eq("pinned", true);
      if ((pinnedCount || 0) >= 50) {
        return errorResponse(400, "pin limit reached (50)");
      }

      // source_session_id must be a UUID or the insert throws a DB error
      // (→ 500). A bad id isn't worth rejecting the pin over — the text is
      // the payload — so just drop the traceability link.
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const sourceIds =
        typeof source_session_id === "string" && UUID_RE.test(source_session_id)
          ? [source_session_id]
          : [];

      const { data, error } = await supabaseAdmin
        .from("core_memories")
        .insert({
          user_id,
          text: summary.trim().slice(0, 400),
          pinned: true,
          source: "user",
          source_session_ids: sourceIds,
        })
        .select("id")
        .single();

      if (error) {
        return errorResponse(500, "Failed to pin memory");
      }
      return jsonResponse(200, { memory_id: data.id, pinned: true, created: true });
    }

    // Mode 1 — toggle an existing core memory's pin.
    if (!memory_id) {
      return errorResponse(400, "memory_id or summary is required");
    }
    if (typeof pinned !== "boolean") {
      return errorResponse(400, "pinned must be a boolean");
    }

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
