// POST /api/threads/toggle-data
// Request: { thread_id, data_opt_in }
// Response: { data_opt_in } (confirmed state)

import { authenticateRequest } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  try {
    const user = await authenticateRequest(event);
    if (user.error) {
      return jsonResponse(user.status || 401, { error: user.error });
    }

    const { thread_id, data_opt_in } = body;

    if (!thread_id) {
      return jsonResponse(400, { error: "thread_id is required" });
    }

    if (typeof data_opt_in !== "boolean") {
      return jsonResponse(400, { error: "data_opt_in must be a boolean" });
    }

    // Verify thread belongs to user
    const { data: thread, error: threadErr } = await supabaseAdmin
      .from("threads")
      .select("id, user_id")
      .eq("id", thread_id)
      .single();

    if (threadErr || !thread) {
      return jsonResponse(404, { error: "Thread not found" });
    }

    if (thread.user_id !== user.user_id) {
      return jsonResponse(403, { error: "Not your thread" });
    }

    const { data, error } = await supabaseAdmin
      .from("threads")
      .update({ data_opt_in })
      .eq("id", thread_id)
      .select("data_opt_in")
      .single();

    if (error) throw error;

    return jsonResponse(200, { data_opt_in: data.data_opt_in });
  } catch (err) {
    console.error("threads/toggle-data error:", err);
    return jsonResponse(500, { error: "Failed to toggle data opt-in" });
  }
}
