// scripts/rollover-check.mjs
// Rollover photo rules: run with  node scripts/rollover-check.mjs
// (also in `npm run check`). Tests lib/rolloverMath.js, the JS copy of
// settle_rollover in migration 019.

import assert from "node:assert/strict";
import { settleRollover, addDays } from "../lib/rolloverMath.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`  FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); }
}

const PAID_LIMIT = 10;
const always = () => true;
const never = () => false;
const idle = () => 0;

// A settled bank as of `through` (today = through + 1 means one finished day).
const base = (through, rollover = 0) => ({ rollover, halvedThrough: through, creditThrough: addDays(through, -1) });

check("paid, idle 3 days: +3", () => {
  // Settled on the 2nd (credit through the 1st). Today the 5th: days 2, 3, 4 finished.
  const r = settleRollover({ ...base("2026-10-02"), today: "2026-10-05", paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.equal(r.rollover, 3);
  assert.equal(r.halvedThrough, "2026-10-05");
  assert.equal(r.creditThrough, "2026-10-04");
});

check("paid, all 10 used: +0 that day; 9 used: +1", () => {
  const used = { "2026-10-02": 10, "2026-10-03": 9 };
  const r = settleRollover({ ...base("2026-10-02"), today: "2026-10-04", paidOn: always, usedDaily: (d) => used[d] || 0, paidLimit: PAID_LIMIT });
  assert.equal(r.rollover, 1);
});

check("free, idle: +0", () => {
  const r = settleRollover({ ...base("2026-10-02"), today: "2026-10-09", paidOn: never, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.equal(r.rollover, 0);
});

check("halving on the 16th: 7 -> 4, 1 -> 1, 0 -> 0", () => {
  for (const [start, want] of [[7, 4], [1, 1], [0, 0]]) {
    const r = settleRollover({ rollover: start, halvedThrough: "2026-10-15", creditThrough: "2026-10-15", today: "2026-10-16", paidOn: never, usedDaily: idle, paidLimit: PAID_LIMIT });
    assert.equal(r.rollover, want, `${start} should halve to ${want}`);
  }
});

check("the 15th is credited, then the 16th halves at its start (in that order)", () => {
  // 3 in the bank, the 15th was a paid idle day: 3 + 1 = 4, then halved on the 16th: 2.
  const r = settleRollover({ rollover: 3, halvedThrough: "2026-10-15", creditThrough: "2026-10-14", today: "2026-10-16", paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.equal(r.rollover, 2);
  // Credit on the 16th itself waits until the 16th is over.
  const next = settleRollover({ ...r, today: "2026-10-17", paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.equal(next.rollover, 3);
});

check("a halving day already done is not halved again", () => {
  const r = settleRollover({ rollover: 8, halvedThrough: "2026-10-16", creditThrough: "2026-10-15", today: "2026-10-16", paidOn: never, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.equal(r.rollover, 8);
});

check("pass ends mid-period: no credit after, bank kept, halving continues", () => {
  // Pass covers Oct 2..Oct 5. Settled on the 2nd, today Nov 2.
  const paid = (d) => d >= "2026-10-02" && d <= "2026-10-05";
  const r = settleRollover({ ...base("2026-10-02"), today: "2026-11-02", paidOn: paid, usedDaily: idle, paidLimit: PAID_LIMIT });
  // +4 (the 2nd..5th), halved on Oct 16 -> 2, halved on Nov 1 -> 1.
  assert.equal(r.rollover, 1);
});

check("founders credit like pass holders", () => {
  const founder = () => true; // paid_on is true every day for a founder
  const r = settleRollover({ ...base("2026-10-02"), today: "2026-10-04", paidOn: founder, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.equal(r.rollover, 2);
});

check("120 idle paid days: never above 31", () => {
  let s = base("2026-10-02");
  let max = 0;
  for (let today = "2026-10-03"; today <= addDays("2026-10-02", 120); today = addDays(today, 1)) {
    s = settleRollover({ ...s, today, paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
    max = Math.max(max, s.rollover);
  }
  assert.ok(max <= 31, `peaked at ${max}`);
  assert.ok(max >= 29, `expected the bank to top out near 31, peaked at ${max}`);
});

check("settling daily or all at once gives the same bank", () => {
  let daily = base("2026-10-02");
  for (let today = "2026-10-03"; today <= "2026-12-20"; today = addDays(today, 1)) {
    daily = settleRollover({ ...daily, today, paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
  }
  const once = settleRollover({ ...base("2026-10-02"), today: "2026-12-20", paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.deepEqual(once, daily);
});

check("first settle after the migration: markers set, no back-credit", () => {
  const r = settleRollover({ rollover: 0, halvedThrough: null, creditThrough: null, today: "2026-10-20", paidOn: always, usedDaily: idle, paidLimit: PAID_LIMIT });
  assert.deepEqual(r, { rollover: 0, halvedThrough: "2026-10-20", creditThrough: "2026-10-19" });
});

if (failures.length) console.log(failures.join("\n"));
console.log(`\nrollover check: passed=${passed} failed=${failures.length}`);
if (failures.length) process.exit(1);
