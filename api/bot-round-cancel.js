// POST /api/bot-round-cancel   (the bot, X-Bot-Secret, owner only)
// Body: { invoker_discord_id, guild_id }
// Response: { status: "ok", round_id, channel_id, message_id } or { status: "no_round" }
//
// /giveaway cancel. Calls off this server's open round; nobody is granted
// anything. The bot disables the round post's button.

import { jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { ownerRequest } from "../lib/bot.js";
import { MSG } from "../lib/giveaway.js";

export async function handler(event) {
  const req = ownerRequest(event, "bot-round-cancel", MSG.notOwner);
  if (req.response) return req.response;
  const { data, error } = await supabaseAdmin.from("giveaway_rounds")
    .update({ status: "cancelled" })
    .eq("guild_id", String(req.body.guild_id ?? ""))
    .eq("status", "open")
    .select("id, channel_id, message_id");
  if (error) {
    console.error("bot-round-cancel failed:", error.message);
    return jsonResponse(500, { status: "error", message: MSG.error });
  }
  const r = data?.[0];
  if (!r) return jsonResponse(200, { status: "no_round", message: MSG.noRound });
  console.log(JSON.stringify({ event: "giveaway_round_cancelled", round_id: r.id }));
  return jsonResponse(200, { status: "ok", round_id: r.id, channel_id: r.channel_id, message_id: r.message_id });
}
