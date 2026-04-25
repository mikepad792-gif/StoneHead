// GET /api/strains/search
// Query params: q (search term), type (optional filter)
// Response: { strains: [{ strain_name, strain_type, effects, flavor, description, rating }] }
//
// Used internally by chat/send for plant tab strain retrieval.
// Returns top 3 matches by keyword against effects, flavor, name, description.

import { authenticateRequest } from "../lib/auth.js";
import { createRequire } from "module";

// JSON import via createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const rawStrains = require("../data/strains.json");

// Normalize strain data keys on load (Source uses capital keys: Strain, Type, etc.)
const normalizedStrains = rawStrains.map((s) => ({
  strain_name: s.Strain || s.strain_name,
  strain_type: (s.Type || s.strain_type || "").toLowerCase(),
  rating: s.Rating || s.rating || 0,
  effects: s.Effects || s.effects || "",
  flavor: s.Flavor || s.flavor || "",
  description: s.Description || s.description || "",
}));

function searchStrains(query, typeFilter) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  let pool = normalizedStrains;
  if (typeFilter && ["indica", "sativa", "hybrid"].includes(typeFilter)) {
    pool = pool.filter((s) => s.strain_type === typeFilter);
  }

  const scored = pool.map((strain) => {
    const searchable = [
      strain.strain_name,
      strain.strain_type,
      strain.effects,
      strain.flavor,
      strain.description,
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (searchable.includes(term)) score++;
      if (strain.strain_name.toLowerCase().includes(term)) score += 2;
      if (strain.effects.toLowerCase().includes(term)) score += 1;
    }
    return { ...strain, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.rating - a.rating)
    .slice(0, 3)
    .map(({ score, ...rest }) => rest);
}

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

    const q = event.queryStringParameters?.q || "";
    const type = event.queryStringParameters?.type || null;

    if (!q.trim()) {
      return jsonResponse(200, { strains: [] });
    }

    const results = searchStrains(q, type);

    return jsonResponse(200, { strains: results });
  } catch (err) {
    console.error("strains/search error:", err);
    return jsonResponse(500, { error: "Strain search failed" });
  }
}
