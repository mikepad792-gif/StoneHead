// POST /api/bot-round-message   (the bot, X-Bot-Secret, owner only)
// Body: { invoker_discord_id, round_id, message_id }
//
// Saves which Discord message is the round's post, so the draw and a cancel
// can disable its Enter button.

import { jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { SNOWFLAKE_RE, ownerRequest } from "../lib/bot.js";
import { MSG } from "../lib/giveaway.js";

export async function handler(event) {
  const req = ownerRequest(event, "bot-round-message", MSG.notOwner);
  if (req.response) return req.response;
  const round_id = Number(req.body.round_id);
  const message_id = String(req.body.message_id ?? "");
  if (!Number.isInteger(round_id) || round_id <= 0 || !SNOWFLAKE_RE.test(message_id)) {
    return jsonResponse(400, { status: "bad_request" });
  }
  const { error } = await supabaseAdmin.from("giveaway_rounds").update({ message_id }).eq("id", round_id);
  if (error) {
    console.error("bot-round-message failed:", error.message);
    return jsonResponse(500, { status: "error" });
  }
  return jsonResponse(200, { status: "ok" });
}
