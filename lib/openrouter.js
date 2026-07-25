// lib/openrouter.js
// Shared OpenRouter client with automatic cross-model fallback.
//
// OpenRouter handles provider fallback within a model. This client adds one
// bounded retry with openrouter/free when the configured model fails, the
// transport fails, or the returned chat completion is unusable.

import { AI_API_URL } from "./config.js";

const FALLBACK_MODEL = "openrouter/free";
const DEFAULT_TIMEOUT_MS = 20_000;

function requestTimeoutMs() {
  const configured = Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS || "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function normalizeModel(model) {
  return typeof model === "string" && model.trim()
    ? model.trim()
    : FALLBACK_MODEL;
}

function hasUsableCompletion(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim().length > 0;
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").slice(0, 300);
  }
  return String(error || "unknown error").replace(/\s+/g, " ").slice(0, 300);
}

async function readHttpError(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // The HTTP status still provides a useful diagnostic without a body.
  }

  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error || parsed;
    return {
      type: error?.error_type || parsed?.error_type || error?.type || "http_error",
      code: error?.code || parsed?.code || res.status,
      message: String(error?.message || text || res.statusText || "request failed")
        .replace(/\s+/g, " ")
        .slice(0, 300),
    };
  } catch {
    return {
      type: "http_error",
      code: res.status,
      message: String(text || res.statusText || "request failed")
        .replace(/\s+/g, " ")
        .slice(0, 300),
    };
  }
}

async function requestModel({ key, model, messages, opts }) {
  const controller = new AbortController();
  const timeoutMs = requestTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://stoneheadai.com",
        "X-Title": "StoneHead AI",
      },
      // Keep model/messages after opts so passthrough options cannot
      // accidentally override routing or the transcript.
      body: JSON.stringify({ ...opts, model, messages }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Chat completion with automatic model fallback.
 *
 * @param {string} model    Configured model slug.
 * @param {Array} messages  OpenRouter messages array.
 * @param {Object} [opts]   Passthrough request-body parameters.
 * @returns {Promise<Object|null>} Parsed response, or null after all attempts.
 */
export async function openrouterChat(model, messages, opts = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error("[openrouter] OPENROUTER_API_KEY not set");
    return null;
  }

  const primaryModel = normalizeModel(model);
  const models = [primaryModel];
  if (primaryModel !== FALLBACK_MODEL) {
    models.push(FALLBACK_MODEL);
  }

  for (let i = 0; i < models.length; i++) {
    const attemptedModel = models[i];
    const fallbackAvailable = i + 1 < models.length;
    let res;

    try {
      res = await requestModel({
        key,
        model: attemptedModel,
        messages,
        opts,
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const reason = timedOut
        ? `timed out after ${requestTimeoutMs()}ms`
        : safeErrorMessage(error);
      const log = fallbackAvailable ? console.warn : console.error;
      log(
        `[openrouter] ${fallbackAvailable ? "primary request failed" : "request failed"} ` +
          `model="${attemptedModel}" transport_error="${reason}"` +
          (fallbackAvailable ? `; trying fallback="${models[i + 1]}"` : "")
      );
      continue;
    }

    if (!res.ok) {
      const error = await readHttpError(res);
      // A different model cannot repair an invalid API key. Other statuses,
      // including 403 guardrail/provider failures, may be model-specific.
      const authFailure = res.status === 401;
      const willFallback = fallbackAvailable && !authFailure;
      const log = willFallback ? console.warn : console.error;
      log(
        `[openrouter] ${willFallback ? "primary model unavailable" : "request rejected"} ` +
          `model="${attemptedModel}" status=${res.status} ` +
          `type="${error.type}" code="${error.code}" message="${error.message}"` +
          (willFallback ? `; trying fallback="${models[i + 1]}"` : "")
      );
      if (willFallback) {
        continue;
      }
      return null;
    }

    let data;
    try {
      data = await res.json();
    } catch (error) {
      const log = fallbackAvailable ? console.warn : console.error;
      log(
        `[openrouter] invalid JSON response model="${attemptedModel}" ` +
          `error="${safeErrorMessage(error)}"` +
          (fallbackAvailable ? `; trying fallback="${models[i + 1]}"` : "")
      );
      continue;
    }

    if (!hasUsableCompletion(data)) {
      const finishReason = data?.choices?.[0]?.finish_reason || "missing";
      const choices = Array.isArray(data?.choices) ? data.choices.length : 0;
      const log = fallbackAvailable ? console.warn : console.error;
      log(
        `[openrouter] unusable completion model="${attemptedModel}" ` +
          `finish_reason="${finishReason}" choices=${choices}` +
          (fallbackAvailable ? `; trying fallback="${models[i + 1]}"` : "")
      );
      continue;
    }

    if (i > 0) {
      console.warn(
        `[openrouter] fallback succeeded primary="${models[0]}" ` +
          `fallback="${attemptedModel}" resolved_model="${data.model || "unknown"}"`
      );
    }
    return data;
  }

  return null;
}
