// lib/config.js
// Centralized config — read from env with sensible defaults.

/** OpenRouter completions endpoint. */
export const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── AI Models ──────────────────────────────────────────────────────
// Each function can use its own model. Set via env (e.g. AI_MODEL_CHAT)
// or fall back to the defaults below. All default to openrouter/free
// which routes to a high-quality free-tier model.

/** Main chat completions. */
export const AI_MODEL_CHAT =
  process.env.AI_MODEL_CHAT || process.env.AI_MODEL || "openrouter/free";

/** Thread title generation (short, deterministic). */
export const AI_MODEL_TITLE =
  process.env.AI_MODEL_TITLE || "openrouter/free";

/** Session memory summarization. */
export const AI_MODEL_SUMMARY =
  process.env.AI_MODEL_SUMMARY || "openrouter/free";

/** Core memory consolidation / reflection. */
export const AI_MODEL_CONSOLIDATION =
  process.env.AI_MODEL_CONSOLIDATION || "openrouter/free";
