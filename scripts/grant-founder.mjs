// scripts/grant-founder.mjs
// Grant (or revoke) Founding Member ("OG Sesher") status for one user.
// OPERATOR-ONLY: this is deliberately a CLI, not an API endpoint — there
// must be no network-reachable way to become a founder.
//
// Usage:  node scripts/grant-founder.mjs <username_or_email>
//         node scripts/grant-founder.mjs --revoke <username_or_email>
//
// Env:    SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same names as
//         lib/supabase.js). Falls back to reading ./.env if they aren't
//         exported in the shell.
//
// Behavior:
//   - Hard cap: FOUNDER_CAP slots total. When they're gone, they're gone —
//     the refusal below is THE mechanism that keeps "only 10" true.
//   - Idempotent: re-running on an existing founder prints their number
//     and exits 0. Never double-grants or renumbers.
//   - Revoke is for the OPERATOR's test grants (e.g. mint yourself, verify
//     the override live, un-mint, then mint the real #1). The app itself
//     still has no path that revokes a founder. Revoke frees the slot;
//     numbering stays max+1, so revoking your test #1 before any other
//     grant means the next founder gets #1.
//   - Operator-run one at a time; no concurrent-grant hardening beyond
//     the sequential read-then-write (per spec: don't over-engineer).

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const FOUNDER_CAP = 10;

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

const args = process.argv.slice(2);
const revoke = args.includes("--revoke");
const identifier = (args.filter((a) => a !== "--revoke")[0] || "").trim();
if (!identifier) {
  console.error("Usage: node scripts/grant-founder.mjs [--revoke] <username_or_email>");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── 1. Cap check (before anything is written) ────────────────────────
const { count: founderCount, error: countErr } = await db
  .from("users")
  .select("id", { count: "exact", head: true })
  .eq("is_founder", true);
if (countErr) {
  console.error("Failed to count founders:", countErr.message);
  process.exit(1);
}

// ── 2. Resolve the user (username first, then email) ─────────────────
const field = identifier.includes("@") ? "email" : "username";
let { data: user, error: findErr } = await db
  .from("users")
  .select("id, username, email, is_founder, founder_number")
  .eq(field, identifier)
  .maybeSingle();
if (!user && !findErr && field === "username") {
  ({ data: user, error: findErr } = await db
    .from("users")
    .select("id, username, email, is_founder, founder_number")
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

// ── Revoke mode (operator test-grant cleanup) ────────────────────────
if (revoke) {
  if (!user.is_founder) {
    console.log(`${user.username} is not a founder. No change.`);
    process.exit(0);
  }
  const oldNumber = user.founder_number;
  const { error: revokeErr } = await db
    .from("users")
    .update({
      is_founder: false,
      founder_number: null,
      founder_granted_at: null,
      // The grant set this true as belt-and-suspenders; reset it so a
      // test account goes back to free tier. If this user had a REAL paid
      // subscription before being minted, restore it manually in Supabase.
      is_subscribed: false,
      subscription_expires: null,
    })
    .eq("id", user.id);
  if (revokeErr) {
    console.error("Revoke failed (nothing written):", revokeErr.message);
    process.exit(1);
  }
  console.log(
    `Revoked OG Sesher #${oldNumber} from ${user.username} (${user.email}). ` +
      `Slot freed. NOTE: is_subscribed reset to false — restore manually if they had a real subscription.`
  );
  process.exit(0);
}

// ── 3. Idempotency: already a founder → report and exit clean ────────
if (user.is_founder) {
  console.log(`${user.username} is already OG Sesher #${user.founder_number}. No change.`);
  process.exit(0);
}

// Cap applies only to NEW grants (checked after idempotency so re-runs
// on existing founders never get refused by a full roster).
if ((founderCount || 0) >= FOUNDER_CAP) {
  console.error(`Founder cap reached (${FOUNDER_CAP}/${FOUNDER_CAP}). No slots left.`);
  process.exit(1);
}

// ── 4. Next number = max existing + 1 ────────────────────────────────
const { data: maxRow, error: maxErr } = await db
  .from("users")
  .select("founder_number")
  .not("founder_number", "is", null)
  .order("founder_number", { ascending: false })
  .limit(1)
  .maybeSingle();
if (maxErr) {
  console.error("Failed to read existing founder numbers:", maxErr.message);
  process.exit(1);
}
const nextNumber = (maxRow?.founder_number || 0) + 1;

// ── 5. Grant ─────────────────────────────────────────────────────────
// is_subscribed=true is belt-and-suspenders for existing subscription
// checks; subscription_expires=null means no expiry path can ever flip
// a founder back (chat-send additionally skips the flip for founders).
const { error: grantErr } = await db
  .from("users")
  .update({
    is_founder: true,
    founder_number: nextNumber,
    founder_granted_at: new Date().toISOString(),
    is_subscribed: true,
    subscription_expires: null,
  })
  .eq("id", user.id);
if (grantErr) {
  console.error("Grant failed (nothing written):", grantErr.message);
  process.exit(1);
}

console.log(`Granted OG Sesher #${nextNumber} to ${user.username} (${user.email}). ${FOUNDER_CAP - (founderCount || 0) - 1} slot(s) left.`);
