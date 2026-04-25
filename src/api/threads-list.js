// GET /api/threads/list
// Query params: tab (optional, "vibe" or "plant")
// Response: { threads: [{ id, title, tab, data_opt_in, created_at, updated_at }] }

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

    const tab = event.queryStringParameters?.tab;

    let query = supabaseAdmin
      .from("threads")
      .select("id, title, tab, data_opt_in, created_at, updated_at")
      .eq("user_id", user.user_id)
      .order("updated_at", { ascending: false });

    if (tab && ["vibe", "plant"].includes(tab)) {
      query = query.eq("tab", tab);
    }

    const { data, error } = await query;
    if (error) throw error;

    return jsonResponse(200, { threads: data || [] });
  } catch (err) {
    console.error("threads/list error:", err);
    return jsonResponse(500, { error: "Failed to load threads" });
  }
}
