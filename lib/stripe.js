// lib/stripe.js
// Stripe passes (StoneHead 2.1). One-time purchases, no subscriptions.
//
// PASSES is the ONLY place a pass's length and Price live. Nothing the client
// sends sets the days or the price: it names a pass, and the server looks it
// up here.

import Stripe from "stripe";

export const PASSES = {
  "7day": { days: 7, priceEnv: "STRIPE_PRICE_7DAY" },
  "30day": { days: 30, priceEnv: "STRIPE_PRICE_30DAY" },
};

let client = null;

/** The Stripe client, or null when STRIPE_SECRET_KEY isn't set. */
export function getStripe() {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  client = new Stripe(key);
  return client;
}

/** Tests only: swap in a stand-in client (or null to reset). */
export function setStripeForTests(stub) {
  client = stub;
}

/** Where Stripe sends people back to. Same rule as the password-reset link. */
export function siteUrl() {
  return (process.env.SITE_URL || "https://stoneheadai.com").replace(/\/+$/, "");
}
