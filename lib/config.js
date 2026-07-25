// lib/config.js
// Centralized config — read from env with sensible defaults.

/** OpenRouter completions endpoint. */
export const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── AI Models ──────────────────────────────────────────────────────
// Each function can use its own model. Set via env (e.g. AI_MODEL_CHAT)
// or inherit AI_MODEL. Blank/whitespace-only values are treated as unset.

const FREE_MODEL = "openrouter/free";

function envModel(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const DEFAULT_MODEL = envModel("AI_MODEL") || FREE_MODEL;

/** Main chat completions. */
export const AI_MODEL_CHAT =
  envModel("AI_MODEL_CHAT") || DEFAULT_MODEL;

/** Thread title generation (short, deterministic). */
export const AI_MODEL_TITLE =
  envModel("AI_MODEL_TITLE") || DEFAULT_MODEL;

/** Session memory summarization. */
export const AI_MODEL_SUMMARY =
  envModel("AI_MODEL_SUMMARY") || DEFAULT_MODEL;

/** Core memory consolidation / reflection. */
export const AI_MODEL_CONSOLIDATION =
  envModel("AI_MODEL_CONSOLIDATION") || DEFAULT_MODEL;
