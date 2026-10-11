// POST /api/bot-round-create   (the bot, X-Bot-Secret, owner only)
// Body: { invoker_discord_id, guild_id, channel_id, prize, pass_days?, bonus_days? }
// Response: { status: "ok", round_id, week_start, draw_at, post_text }
//
// /giveaway start. The round runs Monday to Sunday, Pacific; the draw is
// Sunday 9 PM Pacific (create_giveaway_round, migration 024). One open round
// per server, and only in servers on GIVEAWAY_GUILD_IDS.

import { jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { SNOWFLAKE_RE, giveawayGuilds, ownerRequest } from "../lib/bot.js";
import { MSG, roundPostText } from "../lib/giveaway.js";

const intIn = (v, lo, hi, dflt) => {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : NaN;
};

export async function handler(event) {
  const req = ownerRequest(event, "bot-round-create", MSG.notOwner);
  if (req.response) return req.response;
  const { guild_id, channel_id } = req.body;
  if (!SNOWFLAKE_RE.test(String(guild_id ?? "")) || !SNOWFLAKE_RE.test(String(channel_id ?? ""))) {
    return jsonResponse(400, { status: "bad_request", message: "guild_id and channel_id required" });
  }
  if (!giveawayGuilds().includes(String(guild_id))) {
    return jsonResponse(403, { status: "guild_not_allowed", message: "Giveaways aren't on in this server." });
  }
  const prize = typeof req.body.prize === "string" ? req.body.prize.replace(/[\r\n]+/g, " ").trim() : "";
  const pass_days = intIn(req.body.pass_days, 0, 365, 30);
  const bonus_days = intIn(req.body.bonus_days, 0, 30, 0);
  if (!prize || prize.length > 200 || Number.isNaN(pass_days) || Number.isNaN(bonus_days)) {
    return jsonResponse(400, { status: "bad_request", message: "Prize is 1 to 200 characters, pass days 0 to 365, bonus days 0 to 30." });
  }

  const { data, error } = await supabaseAdmin.rpc("create_giveaway_round", {
    p_guild: String(guild_id), p_channel: String(channel_id), p_prize: prize, p_pass_days: pass_days, p_bonus_days: bonus_days,
  });
  if (error || !data?.status) {
    console.error("bot-round-create failed:", error?.message || "no status");
    return jsonResponse(500, { status: "error", message: MSG.error });
  }
  if (data.status === "already_open") return jsonResponse(409, { status: "already_open", message: MSG.alreadyOpen });
  console.log(JSON.stringify({ event: "giveaway_round_created", round_id: data.round_id, pass_days, bonus_days }));
  return jsonResponse(200, {
    status: "ok", round_id: data.round_id, week_start: data.week_start, draw_at: data.draw_at,
    post_text: roundPostText({ prize, entrant_bonus_days: bonus_days, draw_at: data.draw_at }),
  });
}
