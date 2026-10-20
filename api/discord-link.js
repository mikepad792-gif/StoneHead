// POST /api/discord-link   (signed in)
// Body: { token } from /link-discord, or { code } typed in the profile
// Response: { status, message, discord_username, entered_round }
//
// Links the Discord behind a live request to this account (link_discord,
// migration 024). If that Discord was on another StoneHead account it moves
// here: whoever ran /link owns that Discord. 5 failed tries per account per
// hour, checked first.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { LINK_TRIES_PER_HOUR, SHORT_CODE_RE, TOKEN_RE, linkMessage } from "../lib/discordLink.js";

const reply = (status, extra = {}) => jsonResponse(200, {
  status, message: linkMessage(status, extra),
  discord_username: extra.discord_username ?? null, entered_round: !!extra.entered_round,
  bonus_days: extra.bonus_days || 0,
});

export async function handler(event) {
  if (event.httpMethod !== "POST") return errorResponse(405, "Method not allowed");
  const auth = await authenticateRequest(event);
  if (auth.error) return errorResponse(auth.status, auth.error);
  const { user_id } = auth;

  let body;
  try { body = JSON.parse(event.body || "{}") || {}; } catch { return errorResponse(400, "Invalid JSON body"); }

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from("discord_link_attempts")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", user_id)
    .gte("tried_at", since);
  if (countError) {
    console.error("discord-link: attempt count failed:", countError.message);
    return jsonResponse(500, { status: "error", message: linkMessage("error") });
  }
  if ((count || 0) >= LINK_TRIES_PER_HOUR) return reply("too_many");

  const recordFailure = async () => {
    const { error } = await supabaseAdmin.from("discord_link_attempts").insert({ user_id });
    if (error) console.error("discord-link: attempt insert failed:", error.message);
  };

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
  const args = TOKEN_RE.test(token) ? { p_user: user_id, p_token: token, p_code: null }
    : !token && SHORT_CODE_RE.test(code) ? { p_user: user_id, p_token: null, p_code: code }
    : null;
  if (!args) {
    await recordFailure();
    return reply("bad_link");
  }

  const { data, error } = await supabaseAdmin.rpc("link_discord", args);
  if (error || !data?.status) {
    console.error("discord-link: link_discord failed:", error?.message || "no status");
    return jsonResponse(500, { status: "error", message: linkMessage("error") });
  }
  if (data.status !== "ok") {
    await recordFailure();
    return reply("bad_link");
  }
  console.log(JSON.stringify({ event: "discord_linked", entered_round: !!data.entered_round }));
  return reply("ok", data);
}
