// POST /api/checkout/create
// Body: { pass: "7day" | "30day" }
// Response: { url }  (the client sends the browser there)
//
// Starts a Stripe Checkout for a one-time pass. The pass is granted by the
// webhook (api/stripe-webhook.js) once Stripe says it's paid, never here.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { PASSES, getStripe, siteUrl } from "../lib/stripe.js";
import { REFUND_COOLDOWN_DAYS, refundCooldownUntil } from "../lib/passStatus.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(auth.status, auth.error);
  }
  const { user_id } = auth;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  const pass = body?.pass;
  if (typeof pass !== "string" || !Object.prototype.hasOwnProperty.call(PASSES, pass)) {
    return errorResponse(400, 'pass must be "7day" or "30day"');
  }

  // A refunded pass blocks buying another for a while (buy, use, refund,
  // repeat). Checked before Stripe is touched, so no session is created.
  const blockedUntil = await refundCooldownUntil(supabaseAdmin, user_id);
  if (blockedUntil) {
    return jsonResponse(403, {
      error: `after a refund, passes can't be bought for ${REFUND_COOLDOWN_DAYS} days. you can buy again ${blockedUntil.slice(0, 10)}`,
      blocked_until: blockedUntil,
    });
  }

  const stripe = getStripe();
  const price = process.env[PASSES[pass].priceEnv];
  if (!stripe || !price) {
    console.error("checkout: Stripe isn't configured:", JSON.stringify({ key: !!stripe, price: !!price, pass }));
    return errorResponse(503, "passes aren't available right now");
  }

  try {
    const site = siteUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      client_reference_id: user_id,
      metadata: { user_id, pass },
      success_url: `${site}/?paid=1`,
      cancel_url: `${site}/?paid=0`,
    });
    return jsonResponse(200, { url: session.url });
  } catch (err) {
    console.error("checkout: session create failed:", err?.message || err);
    return errorResponse(502, "couldn't start checkout. try again in a sec");
  }
}
