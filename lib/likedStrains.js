// lib/likedStrains.js
// Shared insert logic for a user's liked strains.
// Used by both api/strains-liked-update.js (explicit endpoint) and
// api/chat-send.js (conversational "save that I love X" path), so the
// dedupe rule lives in exactly one place.

import { supabaseAdmin } from "./supabase.js";

const VALID_TYPES = ["indica", "sativa", "hybrid"];

/**
 * Add a strain to a user's liked_strains, skipping if already present.
 * Dedupe uses a case-insensitive name match (ilike), matching the
 * original endpoint behavior.
 *
 * @param {string} userId      - The authenticated user's id
 * @param {string} strainName  - Strain name to save
 * @param {string} strainType  - "indica" | "sativa" | "hybrid"
 * @param {string} [notes]     - Optional free-text note
 * @returns {Promise<{ added: boolean }>} added=false when it already existed
 */
export async function addLikedStrain(userId, strainName, strainType, notes) {
  if (!userId || !strainName) {
    throw new Error("addLikedStrain: userId and strainName are required");
  }

  const type = String(strainType || "").toLowerCase().trim();
  if (!VALID_TYPES.includes(type)) {
    // DB has a check constraint on strain_type — never attempt an insert
    // that would violate it.
    throw new Error(`addLikedStrain: invalid strain_type "${strainType}"`);
  }

  // Dedupe: already liked? (case-insensitive)
  const { data: existing } = await supabaseAdmin
    .from("liked_strains")
    .select("id")
    .eq("user_id", userId)
    .ilike("strain_name", strainName)
    .maybeSingle();

  if (existing) {
    return { added: false };
  }

  const { error: insertErr } = await supabaseAdmin
    .from("liked_strains")
    .insert({
      user_id: userId,
      strain_name: strainName,
      strain_type: type,
      notes: notes || null,
    });

  if (insertErr) throw insertErr;

  return { added: true };
}
