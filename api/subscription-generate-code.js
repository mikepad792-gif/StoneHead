// POST /api/subscription/generate-code
// Response: { payment_code, expires_at, payment_url }

import { authenticateRequest } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import crypto from "crypto";

const PAYMENT_PAGE_URL =
  process.env.PAYMENT_PAGE_URL || "https://pay.stoneheadai.com";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const user = await authenticateRequest(event);
    if (user.error) {
      return jsonResponse(user.status || 401, { error: user.error });
    }

    // Expire any existing pending codes for this user
    await supabaseAdmin
      .from("payment_codes")
      .update({ status: "expired" })
      .eq("user_id", user.user_id)
      .eq("status", "pending");

    // Expires in 30 minutes
    const expires_at = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    // Generate a unique code — 12 hex chars (48 bits), fixed length, no
    // case-folding entropy loss. One retry on a unique-violation collision
    // (Postgres 23505) before giving up.
    let payment_code;
    for (let attempt = 0; ; attempt++) {
      payment_code = crypto.randomBytes(6).toString("hex").toUpperCase();

      const { error } = await supabaseAdmin.from("payment_codes").insert({
        user_id: user.user_id,
        code: payment_code,
        status: "pending",
        expires_at,
      });

      if (!error) break;
      if (error.code === "23505" && attempt === 0) continue;
      throw error;
    }

    return jsonResponse(200, {
      payment_code,
      expires_at,
      payment_url: `${PAYMENT_PAGE_URL}?code=${payment_code}`,
    });
  } catch (err) {
    console.error("subscription/generate-code error:", err);
    return jsonResponse(500, { error: "Failed to generate payment code" });
  }
}
