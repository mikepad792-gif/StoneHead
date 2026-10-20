// POST /api/bot-round-enter   (the bot, X-Bot-Secret)
// Body: { action: "enter" | "leave" | "status", discord_id, discord_username,
//         round_id (enter, leave), guild_id (status) }
// Response: { status, message, entries?, active_days?, link_url? }
//
// The 🗿 Enter and Leave this week buttons, and /entries. The bot shows
// `message` privately (ephemeral) and, when link_url is set, a button to it.
//
// An entry is saved by Discord id whether or not that Discord is linked yet,
// so finishing the link later is all it takes. Linked is checked at the draw.
//   status: entered | unlinked | left | not_entered | closed | cancelled | no_round

import { errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { SNOWFLAKE_RE, botSecretOk, cleanDiscordName, parseJson } from "../lib/bot.js";
import { startLinkRequest } from "../lib/discordLink.js";
import { MSG, activeDaysThisWeek } from "../lib/giveaway.js";

const ROUND_COLS = "id, status, draw_at, week_start";

async function findRound({ action, round_id, guild_id }) {
  let q = supabaseAdmin.from("giveaway_rounds").select(ROUND_COLS);
  if (action !== "status" || round_id) {
    const id = Number(round_id);
    if (!Number.isInteger(id) || id <= 0) return { bad: true };
    const { data, error } = await q.eq("id", id).maybeSingle();
    return { round: data, error };
  }
  // /entries: this server's open round, or (in a DM) the newest open one.
  q = q.eq("status", "open");
  if (guild_id) q = q.eq("guild_id", String(guild_id));
  const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
  return { round: data?.[0] || null, error };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");
  if (!botSecretOk(event, "bot-round-enter")) return errorResponse(401, "Unauthorized");
  const body = parseJson(event);
  if (!body) return errorResponse(400, "Invalid JSON body");

  const action = body.action || "enter";
  const discord_id = String(body.discord_id ?? "");
  if (!["enter", "leave", "status"].includes(action) || !SNOWFLAKE_RE.test(discord_id)) {
    return errorResponse(400, "action and discord_id required");
  }
  const discord_username = cleanDiscordName(body.discord_username);
  const say = (status, message, extra = {}) => jsonResponse(200, { status, message, ...extra });

  const { round, error: roundError, bad } = await findRound({ action, round_id: body.round_id, guild_id: body.guild_id });
  if (bad) return errorResponse(400, "round_id required");
  if (roundError) {
    console.error("bot-round-enter: round lookup failed:", roundError.message);
    return jsonResponse(500, { status: "error", message: MSG.error });
  }
  if (!round) return say("no_round", MSG.noRound);
  if (round.status === "cancelled") return say("cancelled", MSG.cancelled);
  if (round.status !== "open" || new Date(round.draw_at).getTime() <= Date.now()) {
    // Leaving after the draw changes nothing, and saying so is the same line.
    return say("closed", MSG.closed);
  }

  if (action === "leave") {
    const { error } = await supabaseAdmin.from("giveaway_entries")
      .update({ left_at: new Date().toISOString() })
      .eq("round_id", round.id).eq("discord_id", discord_id).is("left_at", null);
    if (error) {
      console.error("bot-round-enter: leave failed:", error.message);
      return jsonResponse(500, { status: "error", message: MSG.error });
    }
    return say("left", MSG.left);
  }

  if (action === "enter") {
    // Upsert: a second tap is the same entry, and a tap after leaving rejoins.
    const { error } = await supabaseAdmin.from("giveaway_entries")
      .upsert({ round_id: round.id, discord_id, discord_username, left_at: null }, { onConflict: "round_id,discord_id" });
    if (error) {
      console.error("bot-round-enter: enter failed:", error.message);
      return jsonResponse(500, { status: "error", message: MSG.error });
    }
  }

  const [{ data: entry }, { data: user }] = await Promise.all([
    action === "enter"
      ? Promise.resolve({ data: { left_at: null } })
      : supabaseAdmin.from("giveaway_entries").select("left_at").eq("round_id", round.id).eq("discord_id", discord_id).maybeSingle(),
    supabaseAdmin.from("users").select("id").eq("discord_id", discord_id).maybeSingle(),
  ]);
  const inRound = !!entry && !entry.left_at;

  if (!inRound) {
    return say("not_entered", user ? MSG.notEnteredLinked : MSG.notEnteredUnlinked, { round_id: round.id });
  }
  if (user) {
    // Bonus weeks pay as soon as someone has both entered and linked (here,
    // or in link_discord when the link comes second). Once per round; a
    // repeat tap grants nothing and says nothing about it.
    let bonus = 0;
    if (action === "enter") {
      const { data: b, error: bonusError } = await supabaseAdmin.rpc("grant_entry_bonus", { p_discord_id: discord_id });
      if (bonusError) console.error("bot-round-enter: grant_entry_bonus failed:", bonusError.message);
      bonus = b?.days || 0;
    }
    const d = await activeDaysThisWeek(supabaseAdmin, user.id, round.week_start);
    const message = bonus > 0 ? `${MSG.entered(d)} ${MSG.bonusAdded(bonus)}` : MSG.entered(d);
    return say("entered", message, { round_id: round.id, entries: 1 + d, active_days: d, bonus_days: bonus });
  }
  // Entered, not linked: hand them a link in the same reply.
  const link = await startLinkRequest(supabaseAdmin, { discord_id, discord_username }, { reuse: true });
  if (link.status !== "ok") return say("unlinked", MSG.unlinkedNoLink, { round_id: round.id });
  return say("unlinked", MSG.unlinked, { round_id: round.id, link_url: link.url });
}
