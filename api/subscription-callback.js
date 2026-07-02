// api/subscription-callback.js
// -----------------------------------------------------------------------------
// POST /api/subscription/callback
//
// Receives the auth callback from the External Payment Page after a successful
// Stripe payment. This is the ONLY endpoint in the app that is intentionally
// NOT behind authenticateRequest — there is no user session on the calling
// side. The payment page is a decoupled system that only knows a payment_code,
// not who the user is. We look the user up from the code.
//
// Request headers:
//   x-callback-secret: <shared secret>   (required)
//   content-type: application/json
//
// Request body:
//   { code: "<payment_code>" }
//
// Response (200):
//   { success: true, subscription_expires: "<iso timestamp>" }
//
// Error responses all use JSON bodies with { success: false, error: "..." }.
// -----------------------------------------------------------------------------

import { supabaseAdmin } from "../lib/supabase.js";
import { safeEqual } from "../lib/auth.js";

// Duration of a subscription in days. Flagged design decision — see
// THREAD_4_NOTES.md. Change here if product wants a different period.
const SUBSCRIPTION_DAYS = 30;

// Max length we're willing to look up. Generate-code produces ~24–32 chars;
// a generous cap prevents pointless DB lookups from malicious callers.
const CODE_MAX_LENGTH = 128;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function err(statusCode, error) {
  return json(statusCode, { success: false, error });
}

export async function handler(event) {
  // ---- Method gate -------------------------------------------------------
  if (event.httpMethod !== "POST") {
    return err(405, "Method not allowed");
  }

  // ---- Shared-secret gate ------------------------------------------------
  // Since there's no user auth here, we require a shared secret that the
  // external payment page's webhook handler sends. Without this, anyone who
  // guesses or scrapes a payment_code could activate a subscription.
  const expected = process.env.CALLBACK_SECRET;
  if (!expected) {
    // Fail closed. Better to 500 than silently accept unauthenticated calls.
    console.error("CALLBACK_SECRET env var is not set");
    return err(500, "Server misconfigured");
  }
  const provided =
    event.headers?.["x-callback-secret"] ||
    event.headers?.["X-Callback-Secret"];
  if (!safeEqual(provided, expected)) {
    return err(401, "Invalid callback secret");
  }

  // ---- Body parse --------------------------------------------------------
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return err(400, "Invalid JSON body");
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return err(400, "Missing code");
  }
  if (code.length > CODE_MAX_LENGTH) {
    return err(400, "Code too long");
  }

  // ---- Look up the payment code -----------------------------------------
  // Per MASTER_TERMS, the column is `code` (not `payment_code`) in the
  // payment_codes table. The API-level name `payment_code` is only used in
  // the generate-code response.
  const { data: row, error: lookupErr } = await supabaseAdmin
    .from("payment_codes")
    .select("id, user_id, status, expires_at")
    .eq("code", code)
    .maybeSingle();

  if (lookupErr) {
    console.error("payment_codes lookup failed:", lookupErr);
    return err(500, "Database error");
  }
  if (!row) {
    return err(404, "Code not found");
  }

  // ---- Validate code state ----------------------------------------------
  const now = new Date();
  const expiresAt = new Date(row.expires_at);

  if (row.status === "used") {
    return err(400, "Code already used");
  }

  if (row.status === "expired" || expiresAt <= now) {
    // If we caught it past its window but status is still "pending", mark
    // it expired as a side-effect so the DB stays tidy. Best-effort; ignore
    // failures.
    if (row.status === "pending") {
      await supabaseAdmin
        .from("payment_codes")
        .update({ status: "expired" })
        .eq("id", row.id)
        .eq("status", "pending");
    }
    return err(400, "Code expired");
  }

  if (row.status !== "pending") {
    // Defensive — unexpected state.
    return err(400, "Code not usable");
  }

  // ---- Atomic claim: pending -> used ------------------------------------
  // The .eq('status', 'pending') guard makes this safe against two
  // near-simultaneous callbacks for the same code. Only one update will
  // match and return a row; the other gets nothing.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("payment_codes")
    .update({ status: "used" })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (claimErr) {
    console.error("payment_codes claim failed:", claimErr);
    return err(500, "Database error");
  }
  if (!claimed) {
    // Someone else got there first in the microseconds between lookup
    // and update. Treat as already-used.
    return err(409, "Code already used");
  }

  // ---- Compute new subscription_expires ---------------------------------
  // If the user is already subscribed and their subscription hasn't yet
  // lapsed, stack the new period on top of the current expiry rather than
  // overwriting it. This is a small user-friendly choice — see
  // THREAD_4_NOTES.md "Subscription duration & stacking".
  const { data: user, error: userErr } = await supabaseAdmin
    .from("users")
    .select("id, subscription_expires")
    .eq("id", row.user_id)
    .maybeSingle();

  if (userErr || !user) {
    console.error("users lookup failed:", userErr);
    return err(500, "User not found for code");
  }

  const currentExpiry = user.subscription_expires
    ? new Date(user.subscription_expires)
    : null;
  const basis =
    currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(
    basis.getTime() + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000
  );

  // ---- Activate subscription --------------------------------------------
  const { error: updateUserErr } = await supabaseAdmin
    .from("users")
    .update({
      is_subscribed: true,
      subscription_expires: newExpiry.toISOString(),
    })
    .eq("id", user.id);

  if (updateUserErr) {
    console.error("users update failed:", updateUserErr);
    // We've already marked the code 'used'. We don't unwind that — a manual
    // remediation path is cleaner than trying to reverse a state machine.
    return err(500, "Failed to activate subscription");
  }

  return json(200, {
    success: true,
    subscription_expires: newExpiry.toISOString(),
  });
}
