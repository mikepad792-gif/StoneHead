// api/threads-rename.js
// POST /api/threads/rename
// Renames a thread. Requires thread ownership.
// Request:  { thread_id, title }
// Response: { thread_id, title }

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

  const { thread_id, title } = body;
  if (!thread_id) {
    return errorResponse(400, "thread_id is required");
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    return errorResponse(400, "title is required");
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

    // Update title
    await supabaseAdmin
      .from("threads")
      .update({ title: title.trim().slice(0, 100) })
      .eq("id", thread_id);

    return jsonResponse(200, { thread_id, title: title.trim().slice(0, 100) });
  } catch (err) {
    console.error("threads/rename error:", err);
    return errorResponse(500, "Internal server error");
  }
}
