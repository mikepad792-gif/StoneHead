// lib/giveaway.js
// The Weekly Moai Drop (v2.2.0, migration 024): active days and the lines
// the bot shows. The text lives here, not in the bot, so wording changes
// ship with the site. No em dashes.

import { pacificDate } from "./bot.js";

export const MAX_ACTIVE_DAYS = 7;

/**
 * Record today (Pacific) as a day this account used StoneHead. Never throws
 * and never blocks: a miss here costs one entry, not a chat reply.
 */
export async function recordActiveDay(db, user_id, at = new Date()) {
  try {
    const { error } = await db.from("user_active_days")
      .upsert({ user_id, day: pacificDate(at) }, { onConflict: "user_id,day", ignoreDuplicates: true });
    if (error) console.error("active day (non-blocking):", error.message);
  } catch (e) {
    console.error("active day (non-blocking):", e.message);
  }
}

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Days used so far in a round's week (Monday through today), capped at 7. */
export async function activeDaysThisWeek(db, user_id, week_start, at = new Date()) {
  const today = pacificDate(at);
  const sunday = addDays(week_start, 6);
  const upto = today < sunday ? today : sunday;
  if (upto < week_start) return 0;
  const { count, error } = await db.from("user_active_days")
    .select("day", { count: "exact", head: true })
    .eq("user_id", user_id)
    .gte("day", week_start)
    .lte("day", upto);
  if (error) {
    console.error("active days count:", error.message);
    return 0;
  }
  return Math.min(MAX_ACTIVE_DAYS, count || 0);
}

const dayWord = (d) => (d === 1 ? "day" : "days");

export const MSG = {
  entered: (d) => `You're in this week's Moai Drop. Entries so far: ${1 + d} (1 for entering + ${d} ${dayWord(d)} using StoneHead). Every day you use StoneHead this week adds one, up to 7.`,
  unlinked: "Almost in. Tap below to connect your StoneHead account (takes a minute if you're new). Your entry counts as soon as you're linked.",
  unlinkedNoLink: "Almost in. Run /link in a few minutes to connect your StoneHead account. Your entry counts as soon as you're linked.",
  left: "You're out for this week. Tap Enter anytime before Sunday's draw to jump back in.",
  closed: "This week's draw is done. Watch for next week's post.",
  cancelled: "This round was called off. Watch for next week's post.",
  noRound: "No Moai Drop running right now. Watch for the next post.",
  notEnteredLinked: "Tap 🗿 Enter on this week's post.",
  notEnteredUnlinked: "Tap 🗿 Enter to link your account and get in.",
  notOwner: "This one's just for the host.",
  alreadyOpen: "There's already an open round in this server. Draw or cancel it first.",
  nudge: "Tapped Enter but didn't finish linking? Tap 🗿 Enter again for a fresh link. Your entry counts once you're linked.",
  error: "Something went wrong. Try again in a minute.",
};

/** "Oct 18" for the Sunday of the draw, in Pacific time. */
function drawDay(draw_at) {
  return new Date(draw_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
}

/** The round post (the bot adds the 🗿 Enter button under it). */
export function roundPostText({ prize, entrant_bonus_days, draw_at }) {
  return [
    "🗿 The Weekly Moai Drop 🗿",
    "",
    "Tap 🗿 Enter below. That's it.",
    "First time? It'll give you a link to connect your free StoneHead account (about a minute).",
    "Every day you use StoneHead this week = 1 more entry (up to 7).",
    "",
    `Prize: ${prize}`,
    ...(entrant_bonus_days > 0 ? [`Bonus week: everyone who enters gets ${entrant_bonus_days} free days.`] : []),
    `Draw: Sunday ${drawDay(draw_at)} at 9 PM Pacific, live in this channel.`,
    "",
    "Check your entries anytime with /entries.",
  ].join("\n");
}
