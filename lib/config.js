// lib/config.js
// Centralized config — read from env with sensible defaults.

/** OpenRouter completions endpoint. */
export const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── AI Models ──────────────────────────────────────────────────────
// Each function can use its own model. Set via env (e.g. AI_MODEL_CHAT)
// or inherit AI_MODEL. Blank/whitespace-only values are treated as unset.
//
// A model that resolves to NOTHING is a configuration error, not a runtime
// one — see requireModel() below. We throw rather than quietly falling back
// to a free endpoint, because "the app is silently running on a different
// model than you think" is the failure mode that is hardest to notice and
// most expensive to discover from user reports.

function envModel(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Cross-model retry target. Env-configurable ON PURPOSE: the previously
 * hardcoded fallback (nousresearch/hermes-3-llama-3.1-405b:free) was delisted
 * from OpenRouter, and fixing that should not require a code change and a
 * deploy. Set AI_MODEL_FALLBACK to re-point it.
 */
export const AI_MODEL_FALLBACK =
  envModel("AI_MODEL_FALLBACK") || "anthropic/claude-haiku-4.5";

const DEFAULT_MODEL = envModel("AI_MODEL");

/**
 * Resolve a function's model, or throw. Called at module load so a
 * misconfigured deploy fails loudly at cold start instead of serving traffic
 * on an unintended endpoint.
 */
function requireModel(name) {
  const model = envModel(name) || DEFAULT_MODEL;
  if (!model) {
    throw new Error(
      `Missing model configuration: set ${name} or AI_MODEL. ` +
        "Refusing to start on an unconfigured model."
    );
  }
  return model;
}

/** Main chat completions. */
export const AI_MODEL_CHAT = requireModel("AI_MODEL_CHAT");

/** Thread title generation (short, deterministic). */
export const AI_MODEL_TITLE = requireModel("AI_MODEL_TITLE");

/** Session memory summarization. */
export const AI_MODEL_SUMMARY = requireModel("AI_MODEL_SUMMARY");

/** Core memory consolidation / reflection. */
export const AI_MODEL_CONSOLIDATION = requireModel("AI_MODEL_CONSOLIDATION");

// ─── Request timeouts ───────────────────────────────────────────────
// Two values, because the two call sites have different ceilings.

function envMs(name, fallback) {
  const configured = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/**
 * Default per-attempt OpenRouter timeout, used by the BACKGROUND paths
 * (titleGen, sessionMemory, consolidateMemory). They are not bound by the
 * synchronous function ceiling, so they can afford to wait.
 */
export const OPENROUTER_TIMEOUT_MS = envMs("OPENROUTER_TIMEOUT_MS", 20_000);

/**
 * Per-attempt timeout for the SYNCHRONOUS chat path.
 *
 * Netlify kills a synchronous function at 10s. A 20s client timeout means
 * Netlify wins the race — the function is terminated before the timeout
 * fires, so the cross-model retry never gets a chance to run and the user
 * gets a dead request instead of a fallback reply. 8s leaves room for the
 * retry plus response assembly inside the 10s budget.
 */
export const OPENROUTER_TIMEOUT_CHAT_MS = envMs("OPENROUTER_TIMEOUT_CHAT_MS", 8_000);
