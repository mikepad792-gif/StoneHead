// POST /api/promo-redeem
// Body: { code }
// Response: { status, message, days, subscription_expires }
//
// Redeems a promo code for the signed-in account (migration 023). Everything
// about the code (days, window, cap, one use per account) is decided by
// redeem_promo in the database, atomically; the only thing taken from the
// client is the code string. Granted days go through the same grant_pass
// path as a paid pass.
//
// 5 failed tries per account per hour (promo_attempts). A malformed code is
// a failed try too, and the limit is checked first, so a sixth try in the
// hour is refused even when it's a real code.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { CODE_RE, COUNTS_AS_ATTEMPT, REDEEM_TRIES_PER_HOUR, normalizeCode, promoMessage } from "../lib/promo.js";

const reply = (status, extra = {}) =>
  jsonResponse(200, { status, message: promoMessage(status, extra), days: extra.days ?? null, subscription_expires: extra.subscription_expires ?? null });

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from("promo_attempts")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", user_id)
    .gte("tried_at", since);
  if (countError) {
    console.error("promo-redeem: attempt count failed:", countError.message);
    return jsonResponse(500, { status: "error", message: promoMessage("error") });
  }
  if ((count || 0) >= REDEEM_TRIES_PER_HOUR) return reply("too_many");

  const recordFailure = async () => {
    const { error } = await supabaseAdmin.from("promo_attempts").insert({ user_id });
    if (error) console.error("promo-redeem: attempt insert failed:", error.message);
  };

  const code = normalizeCode(body?.code);
  if (!CODE_RE.test(code)) {
    await recordFailure();
    return reply("not_found");
  }

  const { data, error } = await supabaseAdmin.rpc("redeem_promo", { p_user: user_id, p_code: code });
  if (error || !data?.status) {
    console.error("promo-redeem: redeem_promo failed:", error?.message || "no status");
    return jsonResponse(500, { status: "error", message: promoMessage("error") });
  }
  if (COUNTS_AS_ATTEMPT.has(data.status)) await recordFailure();
  if (data.status === "ok") {
    console.log(JSON.stringify({ event: "promo_redeemed", code, days: data.days }));
  }
  return reply(data.status, { days: data.days, subscription_expires: data.subscription_expires });
}
