// scripts/grant-badge.mjs
// Grant a badge from the extensible badge system (migration 007) to one user.
// OPERATOR-ONLY: this is deliberately a CLI, not an API endpoint — with RLS
// default-deny on user_badges, the service-role key used here is the ONLY
// write path. The browser can never grant itself a badge.
//
// This is NOT the founder script. Founder ("OG Sesher") stays on
// scripts/grant-founder.mjs and its own users columns; this script only
// touches badges / user_badges and can never reach the usage gate.
//
// Usage:  node scripts/grant-badge.mjs <username_or_email> <badge_key>
//   e.g.  node scripts/grant-badge.mjs keegoop first_artist
//
// Env:    SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same names as
//         lib/supabase.js). Falls back to reading ./.env if they aren't
//         exported in the shell.
//
// Behavior:
//   - Cap check: refuses when the badge's cap is full. cap=null = uncapped.
//   - Idempotent: re-running on an existing holder prints their number and
//     exits 0. Never double-grants (unique(user_id, badge_key) backstops).
//   - Numbering: max existing number + 1. If two grants race, the
//     unique(badge_key, number) constraint rejects the second — re-run it
//     and it picks up the next number. Fine for a hand-run script.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── Env (shell first, ./.env fallback) ───────────────────────────────
function loadDotEnvFallback() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — the check below reports what's missing */
  }
}
loadDotEnvFallback();

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (export them or put them in ./.env).");
  process.exit(1);
}

const [identifier, badgeKey] = process.argv.slice(2).map((a) => (a || "").trim());
if (!identifier || !badgeKey) {
  console.error("Usage: node scripts/grant-badge.mjs <username_or_email> <badge_key>");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── 1. Resolve the badge + its cap ───────────────────────────────────
const { data: badge, error: badgeErr } = await db
  .from("badges")
  .select("key, label, cap")
  .eq("key", badgeKey)
  .maybeSingle();
if (badgeErr) {
  console.error("Badge lookup failed:", badgeErr.message);
  process.exit(1);
}
if (!badge) {
  console.error(`No such badge: "${badgeKey}". Badge keys live in the badges table (e.g. first_artist).`);
  process.exit(1);
}

// ── 2. Resolve the user (username first, then email) ─────────────────
const field = identifier.includes("@") ? "email" : "username";
let { data: user, error: findErr } = await db
  .from("users")
  .select("id, username, email")
  .eq(field, identifier)
  .maybeSingle();
if (!user && !findErr && field === "username") {
  ({ data: user, error: findErr } = await db
    .from("users")
    .select("id, username, email")
    .eq("email", identifier)
    .maybeSingle());
}
if (findErr) {
  console.error("Lookup failed:", findErr.message);
  process.exit(1);
}
if (!user) {
  console.error(`No user found for "${identifier}" (tried ${field}${field === "username" ? " and email" : ""}).`);
  process.exit(1);
}

// ── 3. Idempotency: already holds it → report and exit clean ─────────
const { data: existing, error: existErr } = await db
  .from("user_badges")
  .select("number")
  .eq("user_id", user.id)
  .eq("badge_key", badge.key)
  .maybeSingle();
if (existErr) {
  console.error("Existing-grant check failed:", existErr.message);
  process.exit(1);
}
if (existing) {
  console.log(`${user.username} already holds ${badge.label} #${existing.number}. No change.`);
  process.exit(0);
}

// ── 4. Cap check (new grants only) ───────────────────────────────────
const { count: holderCount, error: countErr } = await db
  .from("user_badges")
  .select("id", { count: "exact", head: true })
  .eq("badge_key", badge.key);
if (countErr) {
  console.error("Failed to count holders:", countErr.message);
  process.exit(1);
}
if (badge.cap != null && (holderCount || 0) >= badge.cap) {
  console.error(`Cap reached: ${badge.label} allows ${badge.cap}, already granted ${holderCount}. No slots left.`);
  process.exit(1);
}

// ── 5. Next number = max existing + 1 ────────────────────────────────
const { data: maxRow, error: maxErr } = await db
  .from("user_badges")
  .select("number")
  .eq("badge_key", badge.key)
  .not("number", "is", null)
  .order("number", { ascending: false })
  .limit(1)
  .maybeSingle();
if (maxErr) {
  console.error("Failed to read existing badge numbers:", maxErr.message);
  process.exit(1);
}
const nextNumber = (maxRow?.number || 0) + 1;

// ── 6. Grant ─────────────────────────────────────────────────────────
const { error: grantErr } = await db.from("user_badges").insert({
  user_id: user.id,
  badge_key: badge.key,
  number: nextNumber,
});
if (grantErr) {
  console.error("Grant failed (nothing written):", grantErr.message);
  process.exit(1);
}

const slotsLeft = badge.cap != null ? ` ${badge.cap - (holderCount || 0) - 1} slot(s) left.` : "";
console.log(`Granted ${badge.label} #${nextNumber} to ${user.username} (${user.email}).${slotsLeft}`);
