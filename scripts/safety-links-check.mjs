// scripts/safety-links-check.mjs
// Verifies every external URL in lib/safetyResources.js still resolves.
// Run: node scripts/safety-links-check.mjs
//
// NETWORK-OPTIONAL AND NOT IN `npm run check` ON PURPOSE (§4.6). A CI job that
// fails because a third-party site is briefly down teaches people to ignore
// it, and an ignored safety check is worse than no safety check. This is a
// thing you run deliberately.
//
// WHY IT EXISTS AT ALL: these URLs are in the worst possible place for link
// rot. They live inside fixed text no model regenerates, on a path that fires
// rarely, for users who will never report that a link 404'd. Someone in
// trouble gets a dead link and simply doesn't get help — and nothing anywhere
// logs it.
//
// Calendar a manual pass every 6 months regardless. 911, 988 and Never Use
// Alone are stable institutions; third-party maps and mail-order programs are
// not. A 200 also does not mean the PROGRAM still exists — check that the page
// still says what we claim it says.

import { SAFETY_URLS } from "../lib/safetyResources.js";

const TIMEOUT_MS = 15_000;
let failed = 0;

for (const { name, url } of SAFETY_URLS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Some hosts reject HEAD; GET and discard is more honest about reachability.
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (res.ok) {
      console.log(`  OK    ${res.status}  ${name}  ${url}`);
    } else {
      console.error(`  FAIL  ${res.status}  ${name}  ${url}`);
      failed++;
    }
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : err?.message;
    console.error(`  FAIL  --   ${name}  ${url}  (${reason})`);
    failed++;
  } finally {
    clearTimeout(timer);
  }
}

if (failed) {
  console.error(
    `\nsafety-links-check: ${failed} of ${SAFETY_URLS.length} unreachable.\n` +
    "Do NOT just delete the link. Find the replacement first — a missing\n" +
    "resource is a person who doesn't get naloxone."
  );
  process.exit(1);
}

console.log(`\nsafety-links-check: OK — ${SAFETY_URLS.length} URLs reachable`);
