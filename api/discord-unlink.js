// POST /api/discord-unlink   (signed in)
// Response: { status: "ok", message }
//
// Clears the Discord link. Entries tapped from that Discord stop counting
// until it's linked again.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { linkMessage } from "../lib/discordLink.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");
  const auth = await authenticateRequest(event);
  if (auth.error) return errorResponse(auth.status, auth.error);

  const { error } = await supabaseAdmin.from("users")
    .update({ discord_id: null, discord_username: null, discord_linked_at: null })
    .eq("id", auth.user_id);
  if (error) {
    console.error("discord-unlink failed:", error.message);
    return errorResponse(500, linkMessage("error"));
  }
  return jsonResponse(200, { status: "ok", message: linkMessage("unlinked") });
}
