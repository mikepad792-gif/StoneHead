// GET /api/strains/liked
// Query: limit (optional) — e.g. ?limit=5 for the /memory page summary; omit for all
// Response: { liked_strains: [{ strain_name, strain_type, notes, added_at }] }

import { authenticateRequest } from "../lib/auth.js";
import { getTopStrains } from "../lib/likedStrains.js";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    const user = await authenticateRequest(event);
    if (user.error) {
      return jsonResponse(user.status || 401, { error: user.error });
    }

    // 0 / absent → all; positive → that many most recent (the getTopStrains seam).
    const raw = Number(event.queryStringParameters?.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 0;

    const liked_strains = await getTopStrains(user.user_id, limit);

    return jsonResponse(200, { liked_strains });
  } catch (err) {
    console.error("strains/liked error:", err);
    return jsonResponse(500, { error: "Failed to load liked strains" });
  }
}
