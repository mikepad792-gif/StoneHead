// lib/promo.js
// Promo codes (v2.1.4, migration 023): the shared bits of api/promo-redeem.js
// and api/promo-preview.js. The database decides what a code is worth; the
// client only ever sends the code string.

/** 3 to 32 letters and numbers, after trimming and uppercasing. */
export const CODE_RE = /^[A-Z0-9]{3,32}$/;

export function normalizeCode(raw) {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/** Failed redeems allowed per account per hour. */
export const REDEEM_TRIES_PER_HOUR = 5;
/** Statuses that count against that limit. Success, already_used and founder don't. */
export const COUNTS_AS_ATTEMPT = new Set(["not_found", "not_started", "expired", "used_up"]);

const fmtDate = (iso) => {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  } catch { return ""; }
};

/** The user-facing line for a redeem result. No em dashes. */
export function promoMessage(status, { days, subscription_expires } = {}) {
  switch (status) {
    case "ok": return `You're in. ${days} free days added. Your pass now runs through ${fmtDate(subscription_expires)}.`;
    case "already_used": return "You've already used this code.";
    case "not_found": return "That code doesn't work. Check the spelling?";
    case "not_started":
    case "expired": return "That code has expired.";
    case "used_up": return "That code's all used up.";
    case "founder": return "You're a founder, so you already have everything. Save the code for a friend.";
    case "too_many": return "Too many tries. Give it an hour.";
    default: return "Something went wrong. Try again in a minute.";
  }
}
