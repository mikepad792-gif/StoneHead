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

/**
 * Public Discord strain lookup (api/strain-lookup.js).
 *
 * Its own variable rather than sharing AI_MODEL_CHAT, because the two have
 * genuinely different economics and the day they need to diverge should not
 * also be the day someone edits a function to make diverging possible.
 *
 * The bot is free, unauthenticated, and answers strangers in other people's
 * servers; chat is the signed-in product. Discord traffic is spikier, its
 * replies are short and hard-capped, and it has no memory to maintain — so a
 * cheaper model may be the right call there long before it is right for chat,
 * and a model worth paying for in chat may be waste on a one-shot lookup.
 *
 * Blank inherits AI_MODEL, exactly like the other three above — so leaving it
 * unset keeps the bot on whatever the site already runs, which is the state
 * this was introduced in and a perfectly good place to stay.
 */
export const AI_MODEL_BOT = requireModel("AI_MODEL_BOT");

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

// ─── Vision: Talk the Plant photo reads ─────────────────────────────

/**
 * The model that LOOKS at a grow photo (api/plant-photo-read.js). Same
 * OpenRouter key as every other call. There is no separate Anthropic key.
 *
 * Deliberately NOT requireModel(). That inherits AI_MODEL, and AI_MODEL is a
 * text-only DeepSeek, so inheriting it would send photos to a model that
 * cannot see them (OpenRouter answers "no endpoints found that support image
 * input"). Vision gets its own default instead, a Claude model, by decision.
 * Set AI_MODEL_VISION in Netlify to point it anywhere else. If you do, pick a
 * model whose input modalities include image.
 */
export const AI_MODEL_VISION = envModel("AI_MODEL_VISION") || "anthropic/claude-sonnet-5";

/**
 * Cross-model retry for the vision call only. NOT the shared
 * AI_MODEL_FALLBACK: that one exists for text, and the day it gets pointed at
 * a cheaper text-only model, photo retries would start failing for a reason
 * nobody would connect to photos. Set to "none" to turn the retry off.
 */
export const AI_MODEL_VISION_FALLBACK = (() => {
  const value = envModel("AI_MODEL_VISION_FALLBACK");
  if (value && value.toLowerCase() === "none") return null;
  return value || "anthropic/claude-haiku-4.5";
})();

/**
 * Per-attempt timeout for the vision call. It runs in its own synchronous
 * function, so it gets its own budget instead of sharing chat's.
 *
 * 9s assumes the same 10s ceiling OPENROUTER_TIMEOUT_CHAT_MS was written
 * for. Netlify's current docs list a 60s synchronous limit; if the function
 * logs confirm this site gets it, raise this (25000 is comfortable) and slower
 * vision models stop timing out.
 */
export const OPENROUTER_TIMEOUT_VISION_MS = envMs("OPENROUTER_TIMEOUT_VISION_MS", 9_000);

function envCount(name, fallback) {
  const configured = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : fallback;
}

/**
 * Photo reads per UTC day. A photo read on Claude costs on the order of a
 * cent or two; a DeepSeek text turn costs a small fraction of a tenth of a
 * cent. And an empty OpenRouter balance (402) takes down ALL chat, not just
 * photos, so this cap protects the whole app, not just the photo feature.
 *
 * Founders and pass holders get the second number. Their messages are
 * unlimited; photos are metered separately. The defaults are the numbers the
 * Terms of Service state (3 free, 10 with a pass, 2.1), so a missing env var
 * can't make the app disagree with them.
 *
 * 0 is allowed and means off for that group: setting both to 0 is the kill
 * switch for the feature without a code change.
 */
export const PHOTO_DAILY_LIMIT = envCount("PHOTO_DAILY_LIMIT", 3);
export const PHOTO_DAILY_LIMIT_UNLIMITED = envCount("PHOTO_DAILY_LIMIT_UNLIMITED", 10);
