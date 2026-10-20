// lib/bot.js
// Shared bits for the endpoints the Discord bot calls (v2.2.0): the shared
// secret, the owner check, and the giveaway server list. The bot holds no
// database key; it presents BOT_SHARED_SECRET like /strain does.

import { jsonResponse, safeEqual } from "./auth.js";

/** Discord ids are snowflakes: digits only. */
export const SNOWFLAKE_RE = /^\d{15,22}$/;

/** Timing-safe secret check. Refuses everything when the secret isn't set. */
export function botSecretOk(event, label = "bot") {
  const configured = process.env.BOT_SHARED_SECRET;
  if (!configured) {
    console.error(`[${label}] BOT_SHARED_SECRET not set, refusing every request`);
    return false;
  }
  const headers = event.headers || {};
  const presented = headers["x-bot-secret"] || headers["X-Bot-Secret"] || "";
  return safeEqual(presented, configured);
}

/**
 * Only Mike runs giveaways. The bot checks the invoking user's id against
 * its own OWNER_DISCORD_ID; this is the server's second check against the
 * site's copy, so a bot bug can't open it up. Unset means nobody.
 */
export function isOwner(discordId) {
  const owner = (process.env.OWNER_DISCORD_ID || "").trim();
  return !!owner && typeof discordId === "string" && safeEqual(discordId, owner);
}

/** Servers where giveaways may run (GIVEAWAY_GUILD_IDS, comma-separated). */
export function giveawayGuilds() {
  return (process.env.GIVEAWAY_GUILD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** A display name from Discord, made safe to store and show. */
export function cleanDiscordName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
  return s || null;
}

/** The Pacific calendar date (YYYY-MM-DD) of an instant. */
export function pacificDate(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

export function parseJson(event) {
  try { return JSON.parse(event.body || "{}") || {}; } catch { return null; }
}

/**
 * The common front of every owner-only giveaway endpoint: POST, secret,
 * JSON, and invoker_discord_id === OWNER_DISCORD_ID. Returns { body } or
 * { response } to send as-is.
 */
export function ownerRequest(event, label, notOwnerMessage) {
  if (event.httpMethod !== "POST") return { response: jsonResponse(405, { error: "Method not allowed" }) };
  if (!botSecretOk(event, label)) return { response: jsonResponse(401, { error: "Unauthorized" }) };
  const body = parseJson(event);
  if (!body) return { response: jsonResponse(400, { error: "Invalid JSON body" }) };
  if (!isOwner(String(body.invoker_discord_id ?? ""))) {
    console.warn(JSON.stringify({ event: "giveaway_not_owner", endpoint: label }));
    return { response: jsonResponse(403, { status: "not_owner", message: notOwnerMessage }) };
  }
  return { body };
}

/**
 * /drop-entries viewers: ADMIN_DISCORD_IDS (comma-separated), plus the owner.
 * Only decides who can READ the entry list. It has nothing to do with who can
 * enter or win.
 */
export function isAdmin(discordId) {
  if (typeof discordId !== "string" || !discordId) return false;
  if (isOwner(discordId)) return true;
  return (process.env.ADMIN_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
    .some((id) => safeEqual(discordId, id));
}
