// POST /api/support
// Body: { email, message }
// Response: { success: true, emailed }
//
// The support form in the profile. Saves the report (migration 020), then
// emails it to support@ through Resend with the user's email as reply-to, so
// answering is just hitting reply.
//
// The account id, username and account email in the report come from the
// session, never the request body, so a report can't claim to be someone
// else's account. The email typed in the form is only where to write back.
//
// Saved first, emailed second: if Resend is down the report is still in
// support_requests (emailed = false). Only when neither works does the user
// see an error, and it tells them where to write instead.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { sendEmail } from "../lib/email.js";
import { APP_VERSION } from "../src/version.js";

export const MAX_MESSAGE = 2000;
export const DAILY_LIMIT = 5;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const supportTo = () => process.env.SUPPORT_EMAIL_TO || "support@stoneheadai.com";
const supportFrom = () => process.env.SUPPORT_EMAIL_FROM || "StoneHead Support <noreply@stoneheadai.com>";

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
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return errorResponse(400, "enter an email I can reply to");
  }
  if (!message) {
    return errorResponse(400, "tell me what's going on");
  }
  if (message.length > MAX_MESSAGE) {
    return errorResponse(400, `keep it under ${MAX_MESSAGE} characters`);
  }

  // Who's asking, from the session.
  const { data: user } = await supabaseAdmin
    .from("users")
    .select("username, email")
    .eq("id", user_id)
    .maybeSingle();

  // A few a day is plenty for a real problem; more is a stuck button or spam.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count, error: countError } = await supabaseAdmin
    .from("support_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user_id)
    .gte("created_at", since);
  if (!countError && (count || 0) >= DAILY_LIMIT) {
    return errorResponse(429, `that's ${DAILY_LIMIT} today. I've got them, and I'll get back to you by email`);
  }

  const { data: saved, error: saveError } = await supabaseAdmin
    .from("support_requests")
    .insert({ user_id, email, message, app_version: APP_VERSION })
    .select("id")
    .single();
  if (saveError) console.error("support: save failed:", saveError.message);

  const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 60);
  const sent = await sendEmail({
    from: supportFrom(),
    to: supportTo(),
    replyTo: email,
    subject: `[StoneHead support] ${oneLine(user?.username) || user_id}`,
    text: [
      `Reply to: ${email}`,
      `Account ID: ${user_id}`,
      `Username: ${user?.username ?? "(unknown)"}`,
      `Account email: ${user?.email ?? "(unknown)"}`,
      `App version: ${APP_VERSION}`,
      `Sent: ${new Date().toISOString()}`,
      saved?.id ? `Report ID: ${saved.id}` : "Report ID: (not saved)",
      "",
      message,
    ].join("\n"),
  });
  if (!sent.ok) console.error("support: email failed:", sent.error);

  if (saveError && !sent.ok) {
    return errorResponse(502, `couldn't send that. email ${supportTo()} directly`);
  }
  if (sent.ok && saved?.id) {
    const { error: markError } = await supabaseAdmin
      .from("support_requests").update({ emailed: true }).eq("id", saved.id);
    if (markError) console.error("support: mark emailed failed:", markError.message);
  }
  return jsonResponse(200, { success: true, emailed: sent.ok });
}
