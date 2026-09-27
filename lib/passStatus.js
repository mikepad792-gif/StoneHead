// lib/passStatus.js
// Who gets the pass-level photo allowance. One rule for every endpoint.
//
// "Unlimited" in this codebase means founders plus anyone with a pass that
// hasn't ended. is_subscribed alone isn't enough: it stays true until
// chat-send notices the pass ran out, so the end date is checked too.

import { PHOTO_DAILY_LIMIT, PHOTO_DAILY_LIMIT_UNLIMITED } from "./config.js";

/** A pass that hasn't ended yet (founder status is separate). */
export function hasActivePass(user, now = new Date()) {
  if (!user || !user.is_subscribed) return false;
  if (!user.subscription_expires) return true; // no end date recorded: treat as active, as before
  return new Date(user.subscription_expires) > now;
}

/** Founders and pass holders. */
export function isUnlimited(user, now = new Date()) {
  return !!user?.is_founder || hasActivePass(user, now);
}

/**
 * The two numbers the photo functions need: today's allowance for this user,
 * and the pass-level allowance (what a paid day is measured against for
 * rollover credit). Both come from the environment, never the client.
 */
export function photoLimits(user, now = new Date()) {
  return {
    daily_limit: isUnlimited(user, now) ? PHOTO_DAILY_LIMIT_UNLIMITED : PHOTO_DAILY_LIMIT,
    paid_limit: PHOTO_DAILY_LIMIT_UNLIMITED,
  };
}

/** Days a refunded pass blocks buying another (Terms: Money section). */
export const REFUND_COOLDOWN_DAYS = 21;

/**
 * When this user can buy a pass again after a refund: an ISO timestamp, or
 * null when nothing is blocking. Stops buy, use, refund, repeat. Internal
 * accounts (users.is_internal, migration 008) are exempt so the owner can
 * test a purchase and refund without locking themselves out.
 *
 * Fails open: if the lookup errors, the purchase goes through. Refunds are
 * granted by hand, so a missed block is caught there; a broken block would
 * stop every sale.
 */
export async function refundCooldownUntil(db, user_id, now = new Date()) {
  const since = new Date(now.getTime() - REFUND_COOLDOWN_DAYS * 86_400_000).toISOString();
  const [{ data: refunds, error }, { data: user }] = await Promise.all([
    db.from("pass_purchases")
      .select("refunded_at")
      .eq("user_id", user_id)
      .gt("refunded_at", since)
      .order("refunded_at", { ascending: false })
      .limit(1),
    db.from("users").select("is_internal").eq("id", user_id).maybeSingle(),
  ]);
  if (error) {
    console.error("refund cooldown lookup failed (allowing):", error.message);
    return null;
  }
  if (user?.is_internal) return null;
  const last = refunds?.[0]?.refunded_at;
  if (!last) return null;
  return new Date(new Date(last).getTime() + REFUND_COOLDOWN_DAYS * 86_400_000).toISOString();
}
