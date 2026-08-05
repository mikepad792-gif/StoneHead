// lib/safetyResources.js
// Every external URL and phone number the safety layers hand to a person.
//
// WHY THIS FILE EXISTS (§4.6)
// These strings are in the worst possible place for link rot: they live inside
// FIXED text that no model regenerates, on a code path that fires rarely, for
// users who will never report that a link 404'd. Somebody in trouble gets a
// dead link and simply doesn't get help, and nothing anywhere logs it.
//
// So: one block, never inlined into a reply string, and verifiable in one
// place. scripts/safety-links-check.mjs hits each URL and is runnable on
// demand (network-optional, skipped in CI).
//
// MANUAL VERIFICATION EVERY 6 MONTHS. 911, 988 and Never Use Alone are stable
// institutions. Third-party maps and mail-order programs are not.
//
//   Last verified: 2026-08-04
//   Next check due: 2027-02-04

/** Suicide & Crisis Lifeline. Call or text, 24/7. Named once in CRISIS_REPLY. */
export const CRISIS_LINE = "988";

/** Emergency services. */
export const EMERGENCY_LINE = "911";

/**
 * Never Use Alone — overdose spotting line, 24/7.
 * Takes your location, stays on the phone, alerts EMS if you stop responding.
 * Operators have lived experience; no judgment and no lecture about quitting.
 *
 * IMPORTANT: this is the BEFORE-you-use line. An overdose already in progress
 * is a 911 call, not this. Three numbers, three moments — S1 gets this one,
 * S2 gets 911, and 988 is for crisis.
 */
export const NEVER_USE_ALONE = "800-484-3731";

/**
 * Free naloxone by mail. Ships discreetly via USPS, no signature required.
 *
 * Two constraints the copy must respect:
 *   - Coverage is NOT all 50 states — it runs through affiliate partners and
 *     they don't exist everywhere. Never promise delivery.
 *   - NEXT Distro asks people with insurance and easy pharmacy access to use
 *     those instead. It is a limited resource aimed at people who use drugs
 *     and those close to them, so pharmacy comes first in the copy and this
 *     is the "if that's not workable" option.
 */
export const NALOXONE_BY_MAIL = "https://nextdistro.org/naloxone";

/**
 * Free-distribution site map.
 *
 * Use the bare `portal` map, NOT odrescue.com/locate-naloxone/ — the public
 * page is run by FFF Enterprises and carries full commercial navigation
 * (Products, Order, NARCAN listings). Pointing someone who just used at a
 * storefront is the wrong texture.
 *
 * FIELD TEST, Aug 4 2026, Maricopa CA: loaded fine on mobile, but the nearest
 * result was 17.71 miles away and marked "Status: Unverified." That is the map
 * working as designed and still being close to useless for a rural user —
 * which is why the pharmacy line comes first and this comes third. StoneHead's
 * audience skews rural.
 */
export const NALOXONE_LOCATOR = "https://portal.odrescue.com/locator";

/** Everything above, for the link checker to iterate. */
export const SAFETY_URLS = [
  { name: "NALOXONE_BY_MAIL", url: NALOXONE_BY_MAIL },
  { name: "NALOXONE_LOCATOR", url: NALOXONE_LOCATOR },
];
