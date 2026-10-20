// lib/discordLink.js
// Discord linking (v2.2.0, migration 024): making link requests for the bot,
// and the user-facing lines. The bot asks for a link (/link, or 🗿 Enter
// from someone not linked yet); the person opens it on the site and links.

import crypto from "crypto";

export const LINK_TTL_MS = 15 * 60_000;
export const LINK_STARTS_PER_10_MIN = 3;
/** Failed link tries per account per hour (api/discord-link.js). */
export const LINK_TRIES_PER_HOUR = 5;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SHORT_CODE_RE = /^[0-9]{6}$/;

export function siteUrl() {
  return (process.env.URL || "https://stoneheadai.com").replace(/\/+$/, "");
}
export const linkUrl = (token) => `${siteUrl()}/link-discord?t=${token}`;

export function linkMessage(status, { discord_username, entered_round, bonus_days } = {}) {
  switch (status) {
    case "ok": return `Success! Discord linked as ${discord_username || "you"}.${entered_round ? " You're entered in this week's Moai Drop." : ""}${bonus_days > 0 ? ` ${bonus_days} free days added to your pass.` : ""}`;
    case "bad_link": return "This link expired. Run /link in Discord for a fresh one.";
    case "too_many": return "Too many tries. Give it an hour.";
    case "unlinked": return "Discord unlinked.";
    default: return "Something went wrong. Try again in a minute.";
  }
}

/**
 * A link request for one Discord account. Returns { status: "ok", token,
 * short_code, url, expires_at } or { status: "rate_limited" } / { status: "error" }.
 *
 * reuse: hand back a live, unused request with at least 5 minutes left
 * instead of making a new one (an Enter tap from someone still linking).
 * Otherwise the old unused ones are expired first, so only the newest works.
 */
export async function startLinkRequest(db, { discord_id, discord_username }, { reuse = false, now = Date.now() } = {}) {
  if (reuse) {
    const { data: live } = await db
      .from("discord_link_requests")
      .select("token, short_code, expires_at")
      .eq("discord_id", discord_id)
      .is("used_at", null)
      .gt("expires_at", new Date(now + 5 * 60_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    if (live?.[0]) return { status: "ok", ...live[0], url: linkUrl(live[0].token) };
  }

  const { count, error: countError } = await db
    .from("discord_link_requests")
    .select("token", { count: "exact", head: true })
    .eq("discord_id", discord_id)
    .gte("created_at", new Date(now - 10 * 60_000).toISOString());
  if (countError) {
    console.error("discord link: count failed:", countError.message);
    return { status: "error" };
  }
  if ((count || 0) >= LINK_STARTS_PER_10_MIN) return { status: "rate_limited" };

  const nowIso = new Date(now).toISOString();
  await db.from("discord_link_requests").update({ expires_at: nowIso })
    .eq("discord_id", discord_id).is("used_at", null).gt("expires_at", nowIso);
  // Old rows only matter for the limit above.
  await db.from("discord_link_requests").delete().lt("created_at", new Date(now - 86_400_000).toISOString());

  const expires_at = new Date(now + LINK_TTL_MS).toISOString();
  for (let i = 0; i < 5; i++) {
    const token = crypto.randomBytes(32).toString("base64url");
    const short_code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const { error } = await db.from("discord_link_requests")
      .insert({ token, short_code, discord_id, discord_username, expires_at });
    if (!error) return { status: "ok", token, short_code, expires_at, url: linkUrl(token) };
    if (error.code !== "23505") {
      console.error("discord link: insert failed:", error.message);
      return { status: "error" };
    }
  }
  return { status: "error" };
}
