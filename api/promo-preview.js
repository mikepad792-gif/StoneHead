// GET /api/promo-preview?code=XYZ   (no sign-in)
// Response: { valid: true, days } or { valid: false }
//
// For the signed-out banner when someone arrives from a sticker. Says only
// whether a code is usable right now and what it's worth: never why a code
// isn't, so it can't be used to probe codes. 20 lookups per IP per hour,
// counted in this function's memory only; the IP is never stored or logged.

import { jsonResponse, errorResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { CODE_RE, normalizeCode } from "../lib/promo.js";

export const PREVIEWS_PER_HOUR = 20;
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
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }
  const h = event.headers || {};
  const ip = h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0].trim() || "";
  if (overLimit(ip)) return jsonResponse(429, { valid: false });

  const code = normalizeCode(event.queryStringParameters?.code);
  if (!CODE_RE.test(code)) return jsonResponse(200, { valid: false });

  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .select("days, active, starts_at, expires_at, uses, max_uses")
    .eq("code", code)
    .maybeSingle();
  if (error) console.error("promo-preview: lookup failed:", error.message);
  const now = Date.now();
  const usable = !!data && data.active
    && new Date(data.starts_at).getTime() <= now
    && new Date(data.expires_at).getTime() > now
    && data.uses < data.max_uses;
  return jsonResponse(200, usable ? { valid: true, days: data.days } : { valid: false });
}
