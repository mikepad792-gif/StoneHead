// POST /api/strains/liked/update
// Request: { action, strain_name, strain_type, notes }
// Response: { liked_strains: [...] }
//
// Netlify redirect: /api/strains/liked/update -> /.netlify/functions/strains-liked-update

import { authenticateRequest } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { addLikedStrain, escapeLikePattern } from "../lib/likedStrains.js";

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

    const { action, strain_name, strain_type, notes } = JSON.parse(event.body);

    if (!action || !["add", "remove"].includes(action)) {
      return jsonResponse(400, { error: "action must be 'add' or 'remove'" });
    }

    if (!strain_name) {
      return jsonResponse(400, { error: "strain_name is required" });
    }

    if (action === "add") {
      if (!strain_type || !["indica", "sativa", "hybrid"].includes(strain_type)) {
        return jsonResponse(400, { error: "strain_type must be 'indica', 'sativa', or 'hybrid'" });
      }

      // Insert (with dedupe) via the shared helper so the conversational
      // path in chat-send.js stays in lockstep with this endpoint.
      await addLikedStrain(user.user_id, strain_name, strain_type, notes);
    } else {
      // Remove (wildcards escaped — a raw "%" here would delete everything)
      const { error: deleteErr } = await supabaseAdmin
        .from("liked_strains")
        .delete()
        .eq("user_id", user.user_id)
        .ilike("strain_name", escapeLikePattern(strain_name));

      if (deleteErr) throw deleteErr;
    }

    // Return updated list
    const { data: liked_strains, error } = await supabaseAdmin
      .from("liked_strains")
      .select("strain_name, strain_type, notes, added_at")
      .eq("user_id", user.user_id)
      .order("added_at", { ascending: false });

    if (error) throw error;

    return jsonResponse(200, { liked_strains: liked_strains || [] });
  } catch (err) {
    console.error("strains/liked/update error:", err);
    return jsonResponse(500, { error: "Failed to update liked strains" });
  }
}
