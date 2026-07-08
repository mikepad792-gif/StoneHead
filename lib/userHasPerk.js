// lib/userHasPerk.js — SERVER-SIDE ONLY. Not wired to any gate yet.
//
// Dormant seam for future permission-bearing badges. The badges.perks
// JSONB column exists but nothing grants or reads a perk today — this
// helper documents the intended pattern for the day one does:
//
//   - Runs only in a Netlify Function (service-role/server context),
//     never in the browser.
//   - Default-deny: any error, missing perks entry, or unknown perk key
//     grants nothing.
//   - Any gate that ever uses a perk must re-derive it through this —
//     never trust a perk the client asserts.
//
// Founder's paywall bypass does NOT go through here and never will
// under the current design; it stays on users.is_founder in chat-send.

export async function userHasPerk(supabase, userId, perkKey) {
  const { data, error } = await supabase
    .from("user_badges")
    .select("badges ( perks )")
    .eq("user_id", userId);
  if (error || !data) return false; // default-deny
  return data.some((r) => r.badges?.perks?.[perkKey] === true);
}
