// api/admin-metrics.js
// GET /api/admin/metrics
// Founder-only metrics snapshot. Visibility, not steering.
//
// Hard-gated to the founder's OWN account — not is_founder (OG Seshers carry
// that flag too). The gate is the account email, overridable via
// METRICS_ADMIN_EMAIL. Non-founders get a 404, not a 403: this endpoint
// should be indistinguishable from not existing.
//
// Nothing here is ever surfaced to users — no streaks, no counters in the
// UI. Read it with the founder session token:
//   fetch("/api/admin/metrics", { headers: { Authorization:
//     "Bearer " + localStorage.getItem("session_token") } })
//     .then(r => r.json()).then(console.log)

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";

const ADMIN_EMAIL = process.env.METRICS_ADMIN_EMAIL || "towflowapp@gmail.com";

// Optional USD-per-million-token prices for the current model. When unset,
// the cost fields come back null and the token sums stand on their own.
const COST_PER_MTOK_IN = Number(process.env.COST_PER_MTOK_IN) || null;
const COST_PER_MTOK_OUT = Number(process.env.COST_PER_MTOK_OUT) || null;

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }

  try {
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("email")
      .eq("id", auth.user_id)
      .single();

    if (userError || !user || user.email !== ADMIN_EMAIL) {
      return errorResponse(404, "Not found");
    }

    const { data: snapshot, error: rpcError } = await supabaseAdmin.rpc(
      "admin_metrics_snapshot"
    );
    if (rpcError) {
      console.error("admin_metrics_snapshot failed:", rpcError.message);
      return errorResponse(500, "Metrics unavailable");
    }

    // Spend ÷ active users — the number missing from the business plan's
    // economics section. Computed here (not in SQL) so pricing can change
    // without a migration.
    const active30 = snapshot.active_users_30d || 0;
    let spend_usd = null;
    if (COST_PER_MTOK_IN !== null && COST_PER_MTOK_OUT !== null) {
      spend_usd =
        (snapshot.tokens_in_total / 1e6) * COST_PER_MTOK_IN +
        (snapshot.tokens_out_total / 1e6) * COST_PER_MTOK_OUT;
    }

    return jsonResponse(200, {
      ...snapshot,
      spend_usd,
      cost_per_active_user_30d_usd:
        spend_usd !== null && active30 > 0 ? spend_usd / active30 : null,
      tokens_per_active_user_30d:
        active30 > 0
          ? Math.round(
              (snapshot.tokens_in_total + snapshot.tokens_out_total) / active30
            )
          : null,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("admin-metrics error:", err);
    return errorResponse(500, "Internal server error");
  }
}
