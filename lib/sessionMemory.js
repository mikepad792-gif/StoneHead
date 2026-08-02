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

const SUMMARY_TRIGGER_COUNT = 8; // write once a thread reaches this depth
const FETCH_LIMIT = 5;           // fetch last 5 per user
const INJECT_LIMIT = 3;          // inject most recent 3
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
 * Build the system-prompt injection block from the most recent 3 memories.
 * Returns "" when there are none (so the caller can skip it cleanly).
 *
 * Output:
 *   [WHAT YOU REMEMBER ABOUT THIS PERSON]
 *   - 3 days ago (challenge, plant): looking for low-anxiety daytime strains...
 */
export function formatSessionMemoryBlock(memories) {
  if (!memories || memories.length === 0) return "";

  const lines = memories.slice(0, INJECT_LIMIT).map((m) => {
    const days = daysAgo(m.created_at);
    return `- ${days} (${m.frame_tag}, ${m.tab}): ${m.summary}`;
  });

  return `\n\n[WHAT YOU REMEMBER ABOUT THIS PERSON]\n${lines.join("\n")}`;
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

    const summaryResult = await summarizeSession(transcript);
    if (!summaryResult) return;

    const { summary, frame_tag } = summaryResult;

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
          'breakthrough, challenge, friction, trust-building, routine, grounding>"}',
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
