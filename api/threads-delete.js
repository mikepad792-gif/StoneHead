// api/threads-delete.js
// POST /api/threads/delete
// Deletes a thread and all its messages. Requires thread ownership.
// Request:  { thread_id }
// Response: { success: true }

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status || 401, auth.error);
  }
  const { user_id } = auth;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const { thread_id } = body;
  if (!thread_id) {
    return errorResponse(400, "thread_id is required");
  }

  try {
    // Verify ownership
    const { data: thread, error: threadError } = await supabaseAdmin
      .from("threads")
      .select("id, user_id")
      .eq("id", thread_id)
      .eq("user_id", user_id)
      .single();

    if (threadError || !thread) {
      return errorResponse(404, "Thread not found");
    }

    // Delete messages first (foreign key constraint)
    await supabaseAdmin
      .from("messages")
      .delete()
      .eq("thread_id", thread_id);

    // Delete thread
    await supabaseAdmin
      .from("threads")
      .delete()
      .eq("id", thread_id);

    return jsonResponse(200, { success: true });
  } catch (err) {
    console.error("threads/delete error:", err);
    return errorResponse(500, "Internal server error");
  }
}
