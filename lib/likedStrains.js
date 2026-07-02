// lib/likedStrains.js
// Shared insert logic for a user's liked strains.
// Used by both api/strains-liked-update.js (explicit endpoint) and
// api/chat-send.js (conversational "save that I love X" path), so the
// dedupe rule lives in exactly one place.

import { supabaseAdmin } from "./supabase.js";

const VALID_TYPES = ["indica", "sativa", "hybrid"];

/**
 * Strain names in the dataset are slug-style (hyphenated), e.g.
 * "Northern-Lights" or "Northern-Lights--5". Saved/liked strains should
 * read naturally, so collapse hyphens to single spaces before storing.
 *
 * @param {string} name
 * @returns {string} de-hyphenated, whitespace-collapsed name
 */
export function formatStrainName(name) {
  return String(name || "")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Escape LIKE/ILIKE wildcards so a stored name is matched literally.
 * Without this, a name containing % or _ breaks the dedupe here and —
 * worse — a remove of "%" would delete ALL of a user's liked strains.
 */
export function escapeLikePattern(s) {
  return String(s).replace(/[\\%_]/g, "\\$&");
}

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

  // strain_type may be null when the name was taken literally (an unresolved
  // user term). The DB check constraint allows null (migration 005 dropped
  // NOT NULL); anything non-null must be a valid type.
  const rawType = String(strainType || "").toLowerCase().trim();
  const type = VALID_TYPES.includes(rawType) ? rawType : null;

  // Store readable, un-hyphenated names (dataset names are slug-style).
  const name = formatStrainName(strainName);

  // Dedupe: already liked? (case-insensitive, wildcards escaped)
  const { data: existing } = await supabaseAdmin
    .from("liked_strains")
    .select("id")
    .eq("user_id", userId)
    .ilike("strain_name", escapeLikePattern(name))
    .maybeSingle();

  if (existing) {
    return { added: false };
  }

  const { error: insertErr } = await supabaseAdmin
    .from("liked_strains")
    .insert({
      user_id: userId,
      strain_name: name,
      strain_type: type,
      notes: notes || null,
    });

  if (insertErr) throw insertErr;

  return { added: true };
}

/**
 * Top liked strains for a user. v1 returns the most recent N.
 *
 * This is the SEAM for dispensary-data ranking: when last-had / repeat-count
 * data arrives, change what this returns (the /memory page doesn't change).
 *
 * @param {string} userId
 * @param {number} [limit=5]
 * @returns {Promise<Array>} rows { strain_name, strain_type, notes, added_at }
 */
export async function getTopStrains(userId, limit = 5) {
  if (!userId) return [];
  let query = supabaseAdmin
    .from("liked_strains")
    .select("strain_name, strain_type, notes, added_at")
    .eq("user_id", userId)
    .order("added_at", { ascending: false });

  if (limit && limit > 0) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    console.error("getTopStrains error:", error.message);
    return [];
  }
  return data || [];
}
