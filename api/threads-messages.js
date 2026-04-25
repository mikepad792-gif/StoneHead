// GET /api/threads/messages
// Query params: thread_id
// Response: { messages: [{ id, role, content, tokens_in, tokens_out, created_at }] }
// Note: content_augmented is never sent to frontend

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
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const user = await authenticateRequest(event);
    if (user.error) {
      return jsonResponse(user.status || 401, { error: user.error });
    }

    const thread_id = event.queryStringParameters?.thread_id;
    if (!thread_id) {
      return jsonResponse(400, { error: "thread_id is required" });
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

    // Fetch messages — exclude content_augmented (backend-only field)
    const { data: messages, error } = await supabaseAdmin
      .from("messages")
      .select("id, role, content, tokens_in, tokens_out, created_at")
      .eq("thread_id", thread_id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return jsonResponse(200, { messages: messages || [] });
  } catch (err) {
    console.error("threads/messages error:", err);
    return jsonResponse(500, { error: "Failed to load messages" });
  }
}
