// POST /api/bot-link-start   (the Discord bot, X-Bot-Secret)
// Body: { discord_id, discord_username }
// Response: { url, short_code, expires_at }
//
// /link in Discord. Makes a fresh 15-minute link for that Discord account
// (older unused ones stop working) and the 6-digit fallback code. 3 per
// Discord account per 10 minutes.

import { errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { SNOWFLAKE_RE, botSecretOk, cleanDiscordName, parseJson } from "../lib/bot.js";
import { startLinkRequest } from "../lib/discordLink.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");
  if (!botSecretOk(event, "bot-link-start")) return errorResponse(401, "Unauthorized");

  const body = parseJson(event);
  if (!body) return errorResponse(400, "Invalid JSON body");
  const discord_id = String(body.discord_id ?? "");
  if (!SNOWFLAKE_RE.test(discord_id)) return errorResponse(400, "discord_id required");

  const r = await startLinkRequest(supabaseAdmin, { discord_id, discord_username: cleanDiscordName(body.discord_username) });
  if (r.status === "rate_limited") return errorResponse(429, "Too many links. Try again in a few minutes.");
  if (r.status !== "ok") return errorResponse(500, "Couldn't make a link right now. Try again in a minute.");
  return jsonResponse(200, { url: r.url, short_code: r.short_code, expires_at: r.expires_at });
}
