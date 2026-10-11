// POST /api/bot-round-nudge   (the bot, X-Bot-Secret)
// Response: { nudges: [{ round_id, channel_id, message }] }
//
// The bot calls this every few minutes. From 6 PM Pacific, each open round
// is claimed once a day (claim_giveaway_nudges, migration 024), and comes
// back here only if someone tapped Enter and hasn't finished linking. The
// line tags nobody.

import { errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { botSecretOk } from "../lib/bot.js";
import { MSG } from "../lib/giveaway.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");
  if (!botSecretOk(event, "bot-round-nudge")) return errorResponse(401, "Unauthorized");
  const { data, error } = await supabaseAdmin.rpc("claim_giveaway_nudges");
  if (error) {
    console.error("bot-round-nudge failed:", error.message);
    return jsonResponse(500, { nudges: [] });
  }
  const nudges = (data || []).filter((r) => r.unlinked > 0)
    .map((r) => ({ round_id: r.round_id, channel_id: r.channel_id, message: MSG.nudge }));
  return jsonResponse(200, { nudges });
}
