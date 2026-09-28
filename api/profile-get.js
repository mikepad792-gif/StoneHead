// api/profile/get.js
// GET /api/profile/get
//
// Requires: Authorization: Bearer <session_token>
//
// Response fields (MASTER_TERMS.md):
//   user_id              — string (uuid)
//   username             — string
//   email                — string
//   is_subscribed        — boolean
//   subscription_expires — string (ISO timestamp) or null
//   age_verified         — boolean
//   daily_message_count  — integer
//   usage_remaining      — integer or null (null if subscribed)
//   badges               — array of { key, label, color, number } (new badge system; founder is separate)
//   liked_strains        — array of { strain_name, strain_type, notes, added_at }

import { supabaseAdmin } from "../lib/supabase.js";
import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { getUserBadges } from "../lib/getUserBadges.js";
import { FREE_DAILY_LIMIT, TOS_VERSION } from "../lib/constants.js";
import { getPhotoQuota } from "../lib/photoStore.js";
import { hasActivePass, photoLimits, refundCooldownUntil } from "../lib/passStatus.js";
import { visibleAvatarId } from "../lib/avatars.js";
import { PHOTO_DAILY_LIMIT, PHOTO_DAILY_LIMIT_UNLIMITED } from "../lib/config.js";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  // --- Authenticate ---
  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  // --- Fetch user profile ---
  const { data: user, error: userError } = await supabaseAdmin
    .from("users")
    .select(
      "id, username, email, is_subscribed, subscription_expires, age_verified, daily_message_count, last_message_date, is_founder, founder_number, tos_accepted_at, tos_version"
    )
    .eq("id", user_id)
    .single();

  if (userError || !user) {
    return errorResponse(500, "Failed to load user profile");
  }

  // --- Compute daily_message_count with reset logic ---
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let daily_message_count = user.daily_message_count;

  if (user.last_message_date !== today) {
    // Day rolled over — count is effectively 0
    daily_message_count = 0;
  }

  // --- Compute usage_remaining ---
  // Founder wins before subscription logic — a founder is never limited.
  const unlimited = user.is_founder || user.is_subscribed;
  let usage_remaining = null;
  if (!unlimited) {
    usage_remaining = Math.max(0, FREE_DAILY_LIMIT - daily_message_count);
  }

  // --- Fetch liked_strains ---
  const { data: liked_strains, error: strainsError } = await supabaseAdmin
    .from("liked_strains")
    .select("strain_name, strain_type, notes, added_at")
    .eq("user_id", user_id)
    .order("added_at", { ascending: false });

  if (strainsError) {
    return errorResponse(500, "Failed to load liked_strains");
  }

  // --- Fetch badges (new-system badges only; founder stays on its columns) ---
  // getUserBadges returns [] on any error, so a badge hiccup (or the 007
  // migration not having run yet) can never break the profile.
  const badges = await getUserBadges(supabaseAdmin, user_id);

  // --- Thumbs-up "don't show this again" (migration 017) ---
  // Its own read, so a database that hasn't run 017 yet still loads the
  // profile; the dialog just keeps showing.
  const { data: prefs, error: prefsError } = await supabaseAdmin
    .from("users")
    .select("skip_training_prompt")
    .eq("id", user_id)
    .maybeSingle();
  if (prefsError) console.error("profile/get skip_training_prompt (non-blocking):", prefsError.message);

  // --- Photos (migration 019): the quota and the rollover warning toggle ---
  // Both non-blocking for the same reason: a database without 019 still
  // loads the profile, just without photo counts.
  const [photos, { data: rolloverPrefs, error: rolloverError }, pass_blocked_until, { data: avatarRow, error: avatarError }] = await Promise.all([
    getPhotoQuota(supabaseAdmin, { user_id, ...photoLimits(user) }),
    supabaseAdmin.from("users").select("warn_rollover").eq("id", user_id).maybeSingle(),
    refundCooldownUntil(supabaseAdmin, user_id).catch(() => null),
    // Its own read (migration 021), like the others: without it the profile
    // still loads, with the letter avatar.
    supabaseAdmin.from("users").select("avatar_id, self_reported_age_band").eq("id", user_id).maybeSingle(),
  ]);
  if (avatarError) console.error("profile/get avatar_id (non-blocking):", avatarError.message);
  if (rolloverError) console.error("profile/get warn_rollover (non-blocking):", rolloverError.message);

  // --- Return MASTER_TERMS.md response fields ---
  return jsonResponse(200, {
    user_id: user.id,
    username: user.username,
    email: user.email,
    is_subscribed: user.is_subscribed,
    subscription_expires: user.subscription_expires,
    age_verified: user.age_verified,
    daily_message_count,
    usage_remaining,
    is_founder: user.is_founder,
    founder_number: user.founder_number,
    badges,
    liked_strains: liked_strains || [],
    skip_training_prompt: prefs?.skip_training_prompt === true,
    // Passes (2.1): a pass that hasn't ended. is_subscribed alone can lag.
    pass_active: hasActivePass(user),
    // After a refund, no new pass until this time (ISO), or null.
    pass_blocked_until,
    // A 21+ avatar is dropped (letter shown) if the account no longer passes
    // the gate: age detection can flip it after the avatar was picked.
    avatar_id: visibleAvatarId(avatarRow?.avatar_id, { age_verified: user.age_verified, self_reported_age_band: avatarRow?.self_reported_age_band }),
    photos, // quota object or null
    // The two allowances, for the pass picker's copy. From the environment.
    photo_limits: { free: PHOTO_DAILY_LIMIT, pass: PHOTO_DAILY_LIMIT_UNLIMITED },
    warn_rollover: rolloverPrefs ? rolloverPrefs.warn_rollover !== false : true,
    // TRUE when this account still owes an acknowledgement of the CURRENT
    // terms — never accepted, or accepted an older version. The client gates
    // the modal on this rather than on the raw timestamp, so the
    // version-comparison rule lives in one place.
    tos_pending: user.tos_version !== TOS_VERSION,
  });
}
