// POST /api/bot-round-entries   (the bot, X-Bot-Secret, admins only)
// Body: { invoker_discord_id, guild_id }
// Response: { status: "ok", round, entrants, total_people, total_entries,
//             not_counted, left } or { status: "no_round" }
//
// /drop-entries. READ ONLY: lists this server's current round (the open one,
// or the most recent if none is open) through giveaway_round_entries, the
// same function draw_giveaway picks from, so the list is the draw pool.
// Entrants are sorted by total, highest first. Also counts the taps that
// aren't in the pool: not linked yet (or a staff account), or left.
//
// Who may run it: ADMIN_DISCORD_IDS plus OWNER_DISCORD_ID (lib/bot.js
// isAdmin). That list only gates this read; admins enter and count like
// anyone else.

import { errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { botSecretOk, isAdmin, parseJson } from "../lib/bot.js";
import { MSG } from "../lib/giveaway.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");
  if (!botSecretOk(event, "bot-round-entries")) return errorResponse(401, "Unauthorized");
  const body = parseJson(event);
  if (!body) return errorResponse(400, "Invalid JSON body");
  if (!isAdmin(String(body.invoker_discord_id ?? ""))) {
    console.warn(JSON.stringify({ event: "drop_entries_not_admin" }));
    return jsonResponse(403, { status: "not_admin", message: MSG.notOwner });
  }
  const guild_id = String(body.guild_id ?? "");

  const pick = async (open) => {
    let q = supabaseAdmin.from("giveaway_rounds")
      .select("id, status, week_start, draw_at, prize, entrant_bonus_days").eq("guild_id", guild_id);
    if (open) q = q.eq("status", "open");
    return q.order("created_at", { ascending: false }).limit(1);
  };
  let { data: rounds, error } = await pick(true);
  if (!error && !rounds?.length) ({ data: rounds, error } = await pick(false));
  if (error) {
    console.error("bot-round-entries: round lookup failed:", error.message);
    return jsonResponse(500, { status: "error", message: MSG.error });
  }
  const round = rounds?.[0];
  if (!round) return jsonResponse(200, { status: "no_round", message: MSG.noRound });

  const [{ data: pool, error: poolError }, { data: taps, error: tapError }] = await Promise.all([
    supabaseAdmin.rpc("giveaway_round_entries", { p_round: round.id }),
    supabaseAdmin.from("giveaway_entries").select("discord_id, left_at").eq("round_id", round.id),
  ]);
  if (poolError || tapError) {
    console.error("bot-round-entries: entries failed:", (poolError || tapError).message);
    return jsonResponse(500, { status: "error", message: MSG.error });
  }

  const entrants = (pool || [])
    .map((e) => ({
      discord_name: e.discord_name || null, username: e.username || null,
      link_entry: e.link_entry, days: e.days, total: e.total,
    }))
    .sort((a, b) => b.total - a.total || String(a.discord_name).localeCompare(String(b.discord_name)));
  const counted = new Set((pool || []).map((e) => e.discord_id));
  const left = (taps || []).filter((t) => t.left_at).length;
  const not_counted = (taps || []).filter((t) => !t.left_at && !counted.has(t.discord_id)).length;

  const day = (iso, opts) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", ...opts });
  const sunday = new Date(`${round.week_start}T12:00:00Z`);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const md = { weekday: "short", month: "short", day: "numeric" };

  return jsonResponse(200, {
    status: "ok",
    round,
    // Pacific, formatted here so the bot doesn't need time zone data.
    dates_label: `${new Date(`${round.week_start}T12:00:00Z`).toLocaleDateString("en-US", { ...md, timeZone: "UTC" })} to ${sunday.toLocaleDateString("en-US", { ...md, timeZone: "UTC" })}`,
    draw_label: `${day(round.draw_at, { ...md, hour: "numeric", minute: "2-digit" })} PT`,
    entrants,
    total_people: entrants.length,
    total_entries: entrants.reduce((n, e) => n + e.total, 0),
    not_counted,
    left,
  });
}
