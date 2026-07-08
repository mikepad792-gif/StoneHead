// lib/getUserBadges.js
// Returns a user's badges from the extensible badge system (migration 007),
// joined to the badge registry for label/color.
//
// Founder is NOT in here — it renders from its existing users columns
// (is_founder / founder_number), unchanged. The UI shows founder first,
// then these, in one visual strip.
//
// Returns [] on any error so a badge hiccup can never take down the
// endpoint that calls it — badges are cosmetic.

export async function getUserBadges(supabase, userId) {
  const { data, error } = await supabase
    .from("user_badges")
    .select("number, badge_key, badges ( label, color )")
    .eq("user_id", userId)
    .order("granted_at", { ascending: true });
  if (error || !data) return [];
  return data.map((r) => ({
    key: r.badge_key,
    label: r.badges?.label ?? r.badge_key,
    color: r.badges?.color ?? null,
    number: r.number,
  }));
}
