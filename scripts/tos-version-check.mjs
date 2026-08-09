// scripts/tos-version-check.mjs
// Verifies TOS_VERSION agrees with the "Last updated:" line in both legal docs.
// Run: node scripts/tos-version-check.mjs   (also runs inside `npm run check`)
//
// WHY THIS EXISTS. lib/constants.js says, in a comment, that if TOS_VERSION
// disagrees with the docs "that is the bug." Nothing detected it. And the
// failure is silent in the worst way: you edit the terms, forget the constant,
// and nobody is re-prompted — so a user who agreed to the old terms is shown
// as having agreed to the new ones, and there is no signal anywhere that it
// happened. A promise in the Terms ("if I change these terms meaningfully,
// I'll say so in the app") is enforced by one string, and one string with no
// test on it is a wish.
//
// IN `npm run check`, unlike safety-links-check.mjs. That one is out because it
// depends on third-party hosts being up and a flaky safety check teaches people
// to ignore safety checks. This one reads two files off disk — it can only fail
// because something is actually wrong.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TOS_VERSION } from "../lib/constants.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const DOCS = [
  "docs/terms-of-service.md",
  "docs/privacy-policy.md",
];

const LAST_UPDATED_RE = /^\s*\**\s*Last updated:\s*\**\s*(.+?)\s*$/im;

/** "August 5, 2026" -> "2026-08-05". Returns null if it isn't a date we know. */
function toVersion(dateText) {
  const parsed = new Date(`${dateText} UTC`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

let failed = 0;
console.log(`TOS_VERSION = ${TOS_VERSION}`);

for (const rel of DOCS) {
  let text;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch (e) {
    console.error(`  FAIL  ${rel} — cannot read (${e.message})`);
    failed++;
    continue;
  }

  const m = text.match(LAST_UPDATED_RE);
  if (!m) {
    console.error(`  FAIL  ${rel} — no "Last updated:" line found`);
    failed++;
    continue;
  }

  // Strip trailing markdown emphasis the heading may carry.
  const dateText = m[1].replace(/\*+$/g, "").trim();
  const version = toVersion(dateText);
  if (!version) {
    console.error(`  FAIL  ${rel} — "Last updated: ${dateText}" is not a parseable date`);
    failed++;
    continue;
  }

  if (version !== TOS_VERSION) {
    console.error(
      `  FAIL  ${rel} — says ${dateText} (${version}), TOS_VERSION is ${TOS_VERSION}`
    );
    console.error(
      "        Bump TOS_VERSION in lib/constants.js to match — and remember that"
    );
    console.error(
      "        bumping it re-prompts every account, so only do it for a meaningful change."
    );
    failed++;
  } else {
    console.log(`  OK    ${rel} — ${dateText}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} mismatch(es).`);
  process.exit(1);
}
console.log("\nTOS_VERSION matches both documents.");
