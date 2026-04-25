// POST /api/threads/create
// Request: { tab } — "vibe" or "plant"
// Response: { thread_id }

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

  try {
    const user = await authenticateRequest(event);
    if (user.error) {
      return jsonResponse(user.status || 401, { error: user.error });
    }

    const { tab } = JSON.parse(event.body);

    if (!tab || !["vibe", "plant"].includes(tab)) {
      return jsonResponse(400, { error: "Invalid tab — must be 'vibe' or 'plant'" });
    }

    // If plant tab, verify age_verified
    if (tab === "plant") {
      const { data: profile } = await supabaseAdmin
        .from("users")
        .select("age_verified")
        .eq("id", user.user_id)
        .single();

      if (!profile?.age_verified) {
        return jsonResponse(403, { error: "Age verification required for Talk the Plant" });
      }
    }

    const { data, error } = await supabaseAdmin
      .from("threads")
      .insert({
        user_id: user.user_id,
        tab,
        title: tab === "vibe" ? "new vibe" : "new plant chat",
        data_opt_in: false,
      })
      .select("id")
      .single();

    if (error) throw error;

    return jsonResponse(200, { thread_id: data.id });
  } catch (err) {
    console.error("threads/create error:", err);
    return jsonResponse(500, { error: "Failed to create thread" });
  }
}
