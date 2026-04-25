// GET /api/strains/liked
// Response: { liked_strains: [{ strain_name, strain_type, notes, added_at }] }

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

    const { data, error } = await supabaseAdmin
      .from("liked_strains")
      .select("strain_name, strain_type, notes, added_at")
      .eq("user_id", user.user_id)
      .order("added_at", { ascending: false });

    if (error) throw error;

    return jsonResponse(200, { liked_strains: data || [] });
  } catch (err) {
    console.error("strains/liked error:", err);
    return jsonResponse(500, { error: "Failed to load liked strains" });
  }
}
