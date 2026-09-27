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
