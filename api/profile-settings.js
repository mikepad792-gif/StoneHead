// POST /api/profile/settings
// Body: { warn_rollover?: boolean, skip_training_prompt?: boolean, avatar_id?: string | null }
// Response: { warn_rollover?, skip_training_prompt?, avatar_id? }  (what was saved)
//
// The two profile toggles. Each is how a "don't show again" gets undone:
//   warn_rollover         warn before a photo comes out of rollover
//   skip_training_prompt  skip the thumbs-up "share it" dialog
// And the avatar (migration 021): an id from src/avatars.js, or null for the
// letter. A 21+ avatar needs the Talk the Plant gate (lib/avatars.js).
// Only these fields; anything else is ignored.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { findAvatar, passesAdultGate } from "../lib/avatars.js";

const FIELDS = ["warn_rollover", "skip_training_prompt"];

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  const patch = {};
  for (const f of FIELDS) {
    if (body?.[f] === undefined) continue;
    if (typeof body[f] !== "boolean") return errorResponse(400, `${f} must be true or false`);
    patch[f] = body[f];
  }
  if (body?.avatar_id !== undefined) {
    if (body.avatar_id === null) {
      patch.avatar_id = null;
    } else {
      const avatar = findAvatar(body.avatar_id);
      if (!avatar) return errorResponse(400, "that avatar doesn't exist");
      if (avatar.adult) {
        const { data: user } = await supabaseAdmin
          .from("users")
          .select("age_verified, self_reported_age_band")
          .eq("id", auth.user_id)
          .maybeSingle();
        if (!passesAdultGate(user)) return errorResponse(403, "that avatar is 21+");
      }
      patch.avatar_id = avatar.id;
    }
  }
  if (!Object.keys(patch).length) {
    return errorResponse(400, "nothing to update");
  }

  const { error } = await supabaseAdmin.from("users").update(patch).eq("id", auth.user_id);
  if (error) {
    console.error("profile/settings update failed:", error.message);
    return errorResponse(500, "couldn't save that. try again in a sec");
  }
  return jsonResponse(200, patch);
}
