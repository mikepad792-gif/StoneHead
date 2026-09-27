// POST /api/stripe/webhook
// Stripe calls this; nothing else should. Every request is signature-checked
// against STRIPE_WEBHOOK_SECRET before anything is read from it.
//
// Handles two events (subscribe the Stripe endpoint to both):
//   checkout.session.completed, payment_status "paid": grants the pass through
//     grant_pass (migration 019), which stacks on an active pass and is
//     idempotent on the session id, so Stripe's retries never grant twice.
//   charge.refunded, fully refunded: takes the pass back through revoke_pass,
//     which moves any pass stacked after it up to fill the gap. A partial
//     refund leaves the pass alone. Idempotent too.
//
// Every verified event gets a 200 so Stripe stops retrying, EXCEPT when the
// grant itself fails: then a 500, so Stripe retries later instead of the
// purchase being lost.

import { supabaseAdmin } from "../lib/supabase.js";
import { PASSES, getStripe } from "../lib/stripe.js";
import { jsonResponse, errorResponse } from "../lib/auth.js";

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    console.error("stripe webhook: not configured");
    return errorResponse(503, "not configured");
  }

  // Verification needs the exact bytes Stripe signed: never parse first.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  const signature = event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    console.error("stripe webhook: bad signature");
    return errorResponse(400, "bad signature");
  }

  if (stripeEvent.type === "charge.refunded") {
    return handleRefund(stripeEvent.data?.object || {});
  }
  if (stripeEvent.type !== "checkout.session.completed") {
    return jsonResponse(200, { received: true });
  }

  const session = stripeEvent.data?.object || {};
  if (session.payment_status !== "paid") {
    return jsonResponse(200, { received: true });
  }

  const user_id = session.metadata?.user_id;
  const pass = session.metadata?.pass;
  const spec = pass && Object.prototype.hasOwnProperty.call(PASSES, pass) ? PASSES[pass] : null;
  if (!user_id || !spec) {
    // Not one of ours (or tampered with before it reached Stripe). Nothing to grant.
    console.error("stripe webhook: session without a known pass");
    return jsonResponse(200, { received: true });
  }

  const { data, error } = await supabaseAdmin.rpc("grant_pass", {
    p_user_id: user_id,
    p_session_id: session.id,
    p_pass: pass,
    p_days: spec.days,
    p_amount_cents: Number.isFinite(session.amount_total) ? session.amount_total : null,
    p_currency: session.currency || null,
    // What a later refund (charge.refunded) points back at.
    p_payment_intent: idOf(session.payment_intent),
  });
  if (error) {
    console.error("stripe webhook: grant failed:", error.message);
    return errorResponse(500, "grant failed");
  }

  // Never the user id or email.
  if (data?.error === "no_user") {
    console.error(JSON.stringify({ event: "pass_for_missing_account", pass }));
  } else if (!data?.duplicate) {
    console.log(JSON.stringify({ event: "pass_granted", pass }));
  }
  return jsonResponse(200, { received: true });
}

/** Stripe sends expandable fields as an id string or an object with .id. */
function idOf(x) {
  if (!x) return null;
  return typeof x === "string" ? x : x.id || null;
}

async function handleRefund(charge) {
  // Only a FULL refund cancels the pass. A partial refund (a goodwill credit,
  // say) leaves it running.
  if (charge.refunded !== true) {
    console.log(JSON.stringify({ event: "partial_refund_ignored" }));
    return jsonResponse(200, { received: true });
  }
  const payment_intent = idOf(charge.payment_intent);
  if (!payment_intent) {
    console.error("stripe webhook: refund without a payment intent");
    return jsonResponse(200, { received: true });
  }
  const { data, error } = await supabaseAdmin.rpc("revoke_pass", { p_payment_intent: payment_intent });
  if (error) {
    console.error("stripe webhook: revoke failed:", error.message);
    return errorResponse(500, "revoke failed"); // Stripe retries
  }
  if (data?.revoked) {
    console.log(JSON.stringify({ event: "pass_refunded", pass: data.pass }));
  } else if (data?.reason === "not_found") {
    // A refund for something that isn't a pass (or a pass bought before
    // payment intents were recorded): nothing to take back here.
    console.error(JSON.stringify({ event: "refund_without_pass" }));
  }
  return jsonResponse(200, { received: true });
}
