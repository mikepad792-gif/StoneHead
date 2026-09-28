// lib/avatars.js
// Server side of the profile avatars (src/avatars.js is the list).
//
// A 21+ avatar needs the same gate as Talk the Plant: age_verified, and no
// self-reported age band that blocks cannabis. Checked on save AND on read,
// because age detection can flip an account after it picked one.

import { AVATARS } from "../src/avatars.js";
import { blocksCannabis } from "./ageDetect.js";

const BY_ID = new Map(AVATARS.map((a) => [a.id, a]));

/** The manifest entry for an id, or null when it isn't one of ours. */
export function findAvatar(id) {
  return typeof id === "string" ? BY_ID.get(id) || null : null;
}

/** Same rule as the Talk the Plant gate. */
export function passesAdultGate(user) {
  return !!user?.age_verified && !blocksCannabis(user?.self_reported_age_band);
}

/** The avatar this user may show right now, or null for the letter. */
export function visibleAvatarId(avatarId, user) {
  const a = findAvatar(avatarId);
  if (!a) return null;
  if (a.adult && !passesAdultGate(user)) return null;
  return a.id;
}
