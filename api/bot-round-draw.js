// POST /api/bot-round-draw   (the bot, X-Bot-Secret, owner only)
// Body: { invoker_discord_id, guild_id }
// Response: { status: "ok" | "no_entries", round_id, winner_discord_id,
//   winner_name, winner_is_founder, total_people, total_entries, spin_names,
//   prize, channel_id, message_id }
//
// /giveaway draw. Everything happens in draw_giveaway (migration 024), in one
// transaction: count entries (1 for tapping Enter + 1 per Pacific day used
// this week, days capped at 7; linked, not left, not internal), pick, grant
// the prize and any bonus days through grant_pass, save, and lock the round.
// The randomness comes from here: crypto.randomInt, not Postgres random().
// A founder who wins gets no pass; winner_is_founder tells the bot to flag it.

import crypto from "crypto";
import { jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { ownerRequest } from "../lib/bot.js";
import { MSG } from "../lib/giveaway.js";

export async function handler(event) {
  const req = ownerRequest(event, "bot-round-draw", MSG.notOwner);
  if (req.response) return req.response;

  const { data: rounds, error: findError } = await supabaseAdmin.from("giveaway_rounds")
    .select("id").eq("guild_id", String(req.body.guild_id ?? "")).eq("status", "open").limit(1);
  if (findError) {
    console.error("bot-round-draw: find failed:", findError.message);
    return jsonResponse(500, { status: "error", message: MSG.error });
  }
  const round_id = rounds?.[0]?.id;
  if (!round_id) return jsonResponse(200, { status: "no_round", message: MSG.noRound });

  const { data, error } = await supabaseAdmin.rpc("draw_giveaway", {
    p_round: round_id, p_r: crypto.randomInt(0, 2 ** 48 - 1),
  });
  if (error || !data?.status) {
    console.error("bot-round-draw: draw_giveaway failed:", error?.message || "no status");
    return jsonResponse(500, { status: "error", message: MSG.error });
  }
  if (data.status === "not_open" || data.status === "not_found") {
    return jsonResponse(200, { status: "no_round", message: MSG.noRound });
  }
  console.log(JSON.stringify({
    event: "giveaway_drawn", round_id, status: data.status, people: data.total_people,
    entries: data.total_entries, founder_won: !!data.winner_is_founder,
  }));
  return jsonResponse(200, { ...data, round_id });
}
