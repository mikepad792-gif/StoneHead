// lib/sessionMemory.js
// StoneHead — Session memory (Phase 2)
//
// Stores compressed, frame-tagged thread summaries. Mirrors the fire-and-forget
// pattern of generateThreadTitle in chat-send.js (one OpenRouter call, never in
// the response path, never adds latency).
//
// CHANGE 4: fetch the last 5 per user; inject the most recent 3.
// Frame tags use the renamed taxonomy ("grounding", not "reorientation").
//
// Reads/writes via supabaseAdmin (service role, bypasses RLS) — same as the
// rest of the server code.

import { supabaseAdmin } from "./supabase.js";
import { FRAMES } from "./frameDetect.js";
import { stripModelTags } from "./sanitize.js";
import { openrouterChat } from "./openrouter.js";
import { AI_MODEL_SUMMARY } from "./config.js";
import {
  MEMORY_EXCLUSION_NOTE,
  memoryExclusionReasons,
  dropSafetyAdjacent,
} from "./memoryFilter.js";
import { detectCrisis } from "./crisisDetect.js";
import { detectSubstance } from "./substanceDetect.js";

const SUMMARY_TRIGGER_COUNT = 8; // write once a thread reaches this depth
const FETCH_LIMIT = 5;           // fetch last 5 per user
const INJECT_LIMIT = 3;          // inject most recent 3
const CRISIS_INJECT_LIMIT = 1;   // inject ONE while in safety mode (Addendum C5)
const PIN_INJECT_LIMIT = 10;     // newest pinned memories carried into chat
const PIN_MAX_CHARS = 400;       // same cap memory-pin.js applies on insert
const SUMMARY_MAX_TOKENS = 120;  // token budget for the summary completion
const SUMMARY_TEMPERATURE = 0.3; // low temp for deterministic summaries

const VALID_FRAMES = new Set(FRAMES);

/**
 * Fetch the most recent session memories for a user (last 5).
 * @returns {Promise<Array>} rows ordered newest-first; [] on error
 */
export async function fetchSessionMemories(userId) {
  const { data, error } = await supabaseAdmin
    .from("session_memories")
    .select("summary, frame_tag, tab, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(FETCH_LIMIT);

  if (error) {
    console.error("fetchSessionMemories error:", error.message);
    return [];
  }
  return data || [];
}

/**
 * Fetch the user's pinned memories (core_memories rows they pinned), newest
 * first, capped at PIN_INJECT_LIMIT. Unpinning a row takes it out of chat on
 * the next turn. Never throws: a failed read is [] and the turn goes on.
 * @returns {Promise<Array>} [{ text, created_at }]
 */
export async function fetchPinnedMemories(userId) {
  try {
    const { data, error } = await supabaseAdmin
      .from("core_memories")
      .select("text, created_at")
      .eq("user_id", userId)
      .eq("pinned", true)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(PIN_INJECT_LIMIT);

    if (error) {
      console.error("fetchPinnedMemories error:", error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error("fetchPinnedMemories error:", e.message);
    return [];
  }
}

/**
 * Build the system-prompt injection block from the most recent 3 memories,
 * with the person's pinned memories ahead of them.
 * Returns "" when there are none (so the caller can skip it cleanly).
 *
 * Output:
 *   [WHAT YOU REMEMBER ABOUT THIS PERSON]
 *   - 3 days ago (challenge, plant): looking for low-anxiety daytime strains...
 *
 * REDUCED IN SAFETY MODE (Addendum C5). Addendum B said keep memory on crisis
 * turns, reasoning that knowing who someone is helps. That is still true and
 * this does not reverse it. But the C1 failure was an injected memory
 * surfacing at the worst possible moment, and three memories on a crisis turn
 * is three chances for the model to reach for a remembered detail instead of
 * the person in front of it — which is precisely the reaching that crisis.js
 * spends a paragraph forbidding. One memory, and an explicit instruction not
 * to bring it up unasked. Continuity without a prompt to perform it.
 *
 * PINNED MEMORIES are the ones the person marked to keep (memory-pin.js).
 * They go first, under their own label. Not in safety mode: the one-memory
 * rule above holds there, and pins are dropped. A pin is run through the same
 * exclusion filter as a written summary, because a pin's text can arrive
 * straight from the client; one that trips is left out (fails closed). A
 * recent summary that was itself pinned is not listed twice. With no pins
 * the block is exactly what it was before pins existed.
 *
 * @param {Array} memories
 * @param {{ safetyMode?: boolean, pinned?: Array }} [opts]
 */
export function formatSessionMemoryBlock(memories, opts = {}) {
  const pinned = opts.safetyMode ? [] : usablePins(opts.pinned);
  const pinnedKeys = new Set(pinned.map((p) => sameText(p.text)));

  const limit = opts.safetyMode ? CRISIS_INJECT_LIMIT : INJECT_LIMIT;
  const lines = (memories || [])
    .filter((m) => !pinnedKeys.has(sameText(m.summary)))
    .slice(0, limit)
    .map((m) => {
      const days = daysAgo(m.created_at);
      return `- ${days} (${m.frame_tag}, ${m.tab}): ${m.summary}`;
    });

  if (pinned.length === 0 && lines.length === 0) return "";

  const header = opts.safetyMode
    ? "[WHAT YOU REMEMBER ABOUT THIS PERSON — context only. Do not raise it, " +
      "refer to it, or work it into what you say unless they bring it up first.]"
    : "[WHAT YOU REMEMBER ABOUT THIS PERSON]";

  if (pinned.length === 0) return `\n\n${header}\n${lines.join("\n")}`;

  const pinLines = pinned.map((p) => `- ${p.text}`);
  let block =
    `\n\n${header}\n` +
    "Pinned by them (they asked you to keep these in mind; use them when they " +
    "fit, don't recite them):\n" +
    pinLines.join("\n");
  if (lines.length > 0) block += `\nRecent sessions:\n${lines.join("\n")}`;
  return block;
}

/** Pins that may go into the prompt: non-empty, capped, filter-clean. */
function usablePins(pins) {
  if (!Array.isArray(pins)) return [];
  const out = [];
  for (const p of pins) {
    const text = String(p?.text || "").replace(/\s+/g, " ").trim().slice(0, PIN_MAX_CHARS);
    if (!text) continue;
    const reasons = memoryExclusionReasons(text);
    if (reasons.length > 0) {
      console.warn("pinned memory left out of chat by exclusion filter:", JSON.stringify({ reasons }));
      continue;
    }
    out.push({ text });
    if (out.length >= PIN_INJECT_LIMIT) break;
  }
  return out;
}

function sameText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Fire-and-forget: if a thread has reached SUMMARY_TRIGGER_COUNT messages and
 * has no summary yet, generate one (summary + frame_tag) and insert it.
 * Call from chat-send AFTER the response is sent, like generateThreadTitle.
 *
 * @param {object} args
 * @param {string} args.threadId
 * @param {string} args.userId
 * @param {"vibe"|"plant"} args.tab
 * @param {Array}  args.transcript - [{ role, content }] for the thread
 */
export async function maybeWriteSessionMemory({ threadId, userId, tab, transcript }) {
  try {
    const messageCount = Array.isArray(transcript) ? transcript.length : 0;
    if (messageCount < SUMMARY_TRIGGER_COUNT) return;

    // Skip if this thread already has a summary.
    const { data: existing } = await supabaseAdmin
      .from("session_memories")
      .select("id")
      .eq("thread_id", threadId)
      .limit(1);
    if (existing && existing.length > 0) return;

    // Drop safety turns and their immediate neighbours BEFORE summarizing
    // (Addendum C5). If that leaves too little to be worth a memory, write
    // nothing — a two-message summary is noise, and the thread will qualify
    // again on a later ordinary turn.
    const scrubbed = dropSafetyAdjacent(transcript, isSafetyTurn);
    if (scrubbed.length < 4) {
      console.warn("session memory skipped: transcript is mostly safety turns");
      return;
    }

    const summaryResult = await summarizeSession(scrubbed);
    if (!summaryResult) return;

    const { summary, frame_tag } = summaryResult;

    // The enforcement half of the exclusion filter (Addendum C1/C5). The
    // summarizer is asked not to write these; this is what happens when it
    // does anyway. Fails closed — the memory is dropped, not redacted.
    const reasons = memoryExclusionReasons(summary);
    if (reasons.length > 0) {
      console.warn("session memory rejected by exclusion filter:", JSON.stringify({
        reasons, thread_id: threadId,
      }));
      return;
    }

    await supabaseAdmin.from("session_memories").insert({
      user_id: userId,
      thread_id: threadId,
      summary,
      frame_tag: VALID_FRAMES.has(frame_tag) ? frame_tag : "routine",
      tab,
      message_count: messageCount,
    });
  } catch (e) {
    // Non-critical — log and move on.
    console.error("maybeWriteSessionMemory error:", e.message);
  }
}

// ─── Internal ───────────────────────────────────────────────────────

/**
 * Does this user message carry a crisis or substance signal? Passed into
 * dropSafetyAdjacent so memoryFilter.js stays detector-free.
 *
 * Scored per-message with no history on purpose: this is asking "was there
 * something heavy in this turn", not "what tier is the conversation at", and
 * the ±1 window around a false positive costs two dropped messages.
 */
function isSafetyTurn(text) {
  try {
    if (detectCrisis(text).tier >= 1) return true;
    if (detectSubstance(text).tier >= 1) return true;
  } catch {
    // A detector throwing must not take the memory write down with it.
    return false;
  }
  return false;
}

/**
 * One OpenRouter call returning { summary, frame_tag }. Returns null on failure.
 */
async function summarizeSession(transcript) {
  // Keep the prompt cheap: send a trimmed transcript.
  const convo = transcript
    .slice(-16)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const data = await openrouterChat(AI_MODEL_SUMMARY,
    [
      {
        role: "system",
        content:
          "You compress a chat session into memory. Reply with ONLY a JSON " +
          "object, no markdown, no preamble: " +
          '{"summary": "<~50 words on what this session was about, written as ' +
          'something to remember about this person>", "frame_tag": "<one of: ' +
          'breakthrough, challenge, friction, trust-building, routine, grounding>"}' +
          "\n\n" + MEMORY_EXCLUSION_NOTE,
      },
      { role: "user", content: convo },
    ],
    {
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: SUMMARY_TEMPERATURE,
      // No reasoning: 120 tokens leaves zero room for scaffold before the
      // JSON payload.
      reasoning: { enabled: false },
    }
  );

  if (!data) return null;

  let raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;

  // Strip code fences, then extract the JSON object — robust to any scaffold
  // wrapper (<ds_safety>…</ds_safety>) or reasoning prefix around it. Inner
  // tags are cleaned off the summary field below.
  raw = raw.replace(/```json|```/g, "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) raw = jsonMatch[0];

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.summary) return null;
    const summary = stripModelTags(String(parsed.summary)).slice(0, 400);
    if (!summary) return null;
    return {
      summary,
      frame_tag: String(parsed.frame_tag || "routine").toLowerCase().trim(),
    };
  } catch {
    return null;
  }
}

function daysAgo(timestamp) {
  const then = new Date(timestamp).getTime();
  const diffDays = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  return `${diffDays} days ago`;
}
