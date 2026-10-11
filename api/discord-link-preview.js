// GET /api/discord-link-preview?t=TOKEN   (no sign-in)
// Response: { valid: true, discord_username, short_code } or { valid: false }
//
// Lets /link-discord say whose Discord it is before anyone logs in, and show
// the typed-code fallback. Whoever holds the token can already link with it,
// so the code tells them nothing new. 30 lookups per IP per hour, counted in
// this function's memory only; the IP is never stored or logged.

import { errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { TOKEN_RE } from "../lib/discordLink.js";

export const PREVIEWS_PER_HOUR = 30;
const hits = new Map(); // ip -> [timestamps]

export function _resetPreviewLimitForTests() { hits.clear(); }

function overLimit(ip, now = Date.now()) {
  if (!ip) return false;
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) { for (const k of hits.keys()) { hits.delete(k); if (hits.size <= 4000) break; } }
  return recent.length > PREVIEWS_PER_HOUR;
}

export async function handler(event) {
  if (event.httpMethod !== "GET") return errorResponse(405, "Method not allowed");
  const h = event.headers || {};
  const ip = h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim() || "";
  if (overLimit(ip)) return jsonResponse(429, { valid: false });

  const token = event.queryStringParameters?.t || "";
  if (!TOKEN_RE.test(token)) return jsonResponse(200, { valid: false });

  const { data, error } = await supabaseAdmin
    .from("discord_link_requests")
    .select("discord_username, short_code, expires_at, used_at")
    .eq("token", token)
    .maybeSingle();
  if (error) console.error("discord-link-preview: lookup failed:", error.message);
  const live = !!data && !data.used_at && new Date(data.expires_at).getTime() > Date.now();
  return jsonResponse(200, live
    ? { valid: true, discord_username: data.discord_username || "your Discord", short_code: data.short_code }
    : { valid: false });
}
