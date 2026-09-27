// Rotating suggestion chips (src/chipPool.js): content rules and picker.
import assert from "node:assert/strict";
import { VIBE, PLANT, pickChips, rememberShown, RECENT_LIMIT } from "../src/chipPool.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log("  FAIL " + name + ": " + e.message); }
}
// Seeded RNG so every run is repeatable.
// mulberry32: small seeds still give well-spread numbers (a plain LCG seeded
// with 1..200 starts near zero every time and skews the shuffle).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const plantAll = Object.values(PLANT).flatMap((c) => c.items);
const allTexts = [...VIBE.map((c) => c.text), ...plantAll];

check("pool sizes", () => {
  assert.ok(VIBE.length >= 30, "vibe pool " + VIBE.length);
  for (const [k, c] of Object.entries(PLANT)) assert.ok(c.items.length >= 10, k + " pool " + c.items.length);
});
check("no duplicate chips anywhere", () => {
  assert.equal(new Set(allTexts).size, allTexts.length);
});
check("no long dashes in any chip", () => {
  for (const t of allTexts) assert.equal(/[\u2013\u2014]/.test(t), false, t);
});
check("house style: lowercase start, lowercase i", () => {
  for (const t of allTexts) {
    assert.equal(t[0], t[0].toLowerCase(), t);
    assert.equal(/\bI\b/.test(t), false, t);
  }
});
check("vibe is 13+: nothing about getting high", () => {
  const drug = /\b(high|weed|cannabis|strain|smok|edible|thc|cbd|stoned|blunt|joint|dab)/i;
  for (const c of VIBE) assert.equal(drug.test(c.text), false, c.text);
});
check("vibe pick: 4 distinct chips from the vibe pool", () => {
  for (let s = 1; s <= 200; s++) {
    const p = pickChips("vibe", [], rng(s));
    assert.equal(p.length, 4); assert.equal(new Set(p.map((c) => c.text)).size, 4);
    for (const c of p) assert.ok(VIBE.some((v) => v.text === c.text));
  }
});
check("plant pick: exactly one chip from each category", () => {
  for (let s = 1; s <= 200; s++) {
    const p = pickChips("plant", [], rng(s));
    assert.equal(p.length, 4);
    for (const cat of Object.values(PLANT)) assert.equal(p.filter((c) => cat.items.includes(c.text)).length, 1);
  }
});
check("cooldown: recently shown chips are skipped", () => {
  let recent = [];
  for (let s = 1; s <= 100; s++) {
    const p = pickChips("vibe", recent, rng(s));
    for (const c of p) assert.equal(recent.includes(c.text), false, "repeat: " + c.text);
    recent = rememberShown(recent, p.map((c) => c.text), RECENT_LIMIT.vibe);
  }
});
check("cooldown on plant too", () => {
  let recent = [];
  for (let s = 1; s <= 100; s++) {
    const p = pickChips("plant", recent, rng(s));
    for (const c of p) assert.equal(recent.includes(c.text), false, "repeat: " + c.text);
    recent = rememberShown(recent, p.map((c) => c.text), RECENT_LIMIT.plant);
  }
});
check("the whole vibe pool comes around", () => {
  let recent = []; const seen = new Set();
  for (let s = 1; s <= 60; s++) {
    const p = pickChips("vibe", recent, rng(s));
    p.forEach((c) => seen.add(c.text));
    recent = rememberShown(recent, p.map((c) => c.text), RECENT_LIMIT.vibe);
  }
  assert.equal(seen.size, VIBE.length);
});
check("still 4 chips if recent covers the whole pool", () => {
  assert.equal(pickChips("vibe", VIBE.map((c) => c.text), rng(3)).length, 4);
  assert.equal(pickChips("plant", plantAll, rng(3)).length, 4);
});
check("rememberShown: newest first, deduped, capped", () => {
  assert.deepEqual(rememberShown(["a", "b", "c"], ["c", "d"], 4), ["c", "d", "a", "b"]);
  assert.equal(rememberShown([], Array.from({ length: 30 }, (_, i) => "x" + i), 12).length, 12);
});

console.log(`chips check: passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
