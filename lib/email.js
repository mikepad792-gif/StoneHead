// lib/email.js
// Sending email through Resend (https://resend.com), the same provider the
// password-reset emails already use via Supabase's SMTP settings. Plain REST,
// no SDK: one POST per email.
//
// RESEND_API_KEY must be set in Netlify. Without it, sendEmail() returns
// { ok: false } and callers fall back (the support form still saves the report).

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 8000;

let sendForTests = null;
/** Test hook: replace the network call. Pass null to restore. */
export function setEmailSenderForTests(fn) { sendForTests = fn; }

/**
 * Send one plain-text email. Never throws.
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
export async function sendEmail({ from, to, replyTo, subject, text }) {
  const payload = { from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) };
  if (sendForTests) return sendForTests(payload);

  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set" };
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${data?.message || "no message"}` };
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
