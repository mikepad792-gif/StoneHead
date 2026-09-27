// lib/rolloverMath.js
// Pure-JS copy of settle_rollover (supabase/migrations/019). The database is
// the one that actually settles; this exists so the rules can be tested in
// Node (scripts/rollover-check.mjs). Change both together.
//
// Rules (Mike's):
//   - At the END of each UTC day on which the user had a pass (or is a
//     founder) and used fewer than the paid daily limit: +1 rollover.
//   - At the START of the 1st and 16th: rollover = ceil(rollover / 2).
//   - Halving happens before that day's credit, and today is never credited
//     (it isn't over).

/** "2026-09-26" + n days, in UTC. */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Is this a halving day (the 1st or 16th)? */
export function isHalvingDay(day) {
  const dom = Number(day.slice(8, 10));
  return dom === 1 || dom === 16;
}

/**
 * Bring a rollover bank up to date.
 *
 * @param {object} s
 * @param {number} s.rollover
 * @param {string|null} s.halvedThrough   last day whose halving is done
 * @param {string|null} s.creditThrough   last day whose credit is done
 * @param {string} s.today                UTC "YYYY-MM-DD"
 * @param {(day:string)=>boolean} s.paidOn
 * @param {(day:string)=>number} s.usedDaily
 * @param {number} s.paidLimit
 * @returns {{ rollover:number, halvedThrough:string, creditThrough:string }}
 */
export function settleRollover({ rollover, halvedThrough, creditThrough, today, paidOn, usedDaily, paidLimit }) {
  if (halvedThrough == null && creditThrough == null) {
    // First settle ever: set the markers, credit nothing.
    return { rollover, halvedThrough: today, creditThrough: addDays(today, -1) };
  }
  let halved = halvedThrough ?? creditThrough;
  let credit = creditThrough ?? halvedThrough;
  let roll = rollover;
  let day = addDays(halved < credit ? halved : credit, 1);
  while (day <= today) {
    if (isHalvingDay(day) && day > halved) roll = Math.ceil(roll / 2);
    if (day < today && day > credit && paidOn(day) && (usedDaily(day) || 0) < paidLimit) roll += 1;
    day = addDays(day, 1);
  }
  const yesterday = addDays(today, -1);
  return {
    rollover: roll,
    halvedThrough: halved > today ? halved : today,
    creditThrough: credit > yesterday ? credit : yesterday,
  };
}
