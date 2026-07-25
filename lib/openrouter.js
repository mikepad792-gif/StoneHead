// lib/openrouter.js
// Shared OpenRouter client with automatic model fallback.
//
// Each caller passes its own model (from config). If that model fails
// (typo, quota exceeded, rate-limited, etc.), logs a warning and retries
// once with a free-tier fallback.

import { AI_API_URL } from "./config.js";

/** Fallback when the configured model is unavailable. */
const FALLBACK_MODEL = "openrouter/free";

/**
 * Check whether an HTTP error body indicates a model-specific failure
 * (model not found, quota exceeded, rate-limited) rather than a general
 * network / auth problem.
 */
function isModelError(text) {
  if (!text) return false;
  return /model.*(not\s+found|unavailable|does\s+not\s+exist|quota|limit|rate|try\s+again)/i.test(text);
}

/**
 * Chat completion with automatic model fallback.
 *
 * @param {string} model    - The model slug to try first (e.g. AI_MODEL_CHAT).
 * @param {Array}  messages - OpenRouter messages array.
 * @param {Object} [opts]   - Passthrough body params (max_tokens, temperature,
 *                           reasoning, frequency_penalty, presence_penalty…).
 * @returns {Object|null}   Parsed OpenRouter response body, or null on failure.
 */
export async function openrouterChat(model, messages, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error("[openrouter] OPENROUTER_API_KEY not set");
    return null;
  }

  // Build the model chain: caller's model → fallback (if different).
  const models = [model];
  if (model !== FALLBACK_MODEL) {
    models.push(FALLBACK_MODEL);
  }

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://stoneheadai.com",
        "X-Title": "StoneHead AI",
      },
      body: JSON.stringify({ model: m, messages, ...opts }),
    });

    if (res.ok) {
      if (i > 0) {
        console.warn(
          `[openrouter] fell back to "${m}" (primary "${models[0]}" was unavailable)`
        );
      }
      return res.json();
    }

    const errText = await res.text();

    // First attempt: try fallback only if the error is model-specific.
    if (i === 0 && isModelError(errText)) {
      console.warn(
        `[openrouter] model "${m}" error (${res.status}): ${errText.slice(0, 200)}. Trying fallback…`
      );
      continue;
    }

    // Non-model error, or last model in chain — give up.
    console.error(
      `[openrouter] ${res.status} from "${m}": ${errText.slice(0, 300)}`
    );
    return null;
  }

  return null;
}
