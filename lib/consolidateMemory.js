// lib/consolidateMemory.js
// StoneHead — Memory consolidation / reflection (Phase 2.5, Section 3)
//
// Re-derives a small set of "core memories" from the session_memories log.
// Fire-and-forget, same slot as the other background writes. HIGHEST-RISK
// component — ships DARK: it writes core_memories rows, but the /memory page's
// Core section is flag-gated off until the output is validated post-launch.
//
// The two Senna guards (against closed-loop drift) are non-negotiable:
//   1. TRIGGER on fresh material only — runs when >= NEW_MEMORY_THRESHOLD new
//      session_memories arrived since last_consolidated_at. No cron: the job
//      fires only because new ground truth showed up, never over a frozen base.
//   2. ANCHORING — each cycle re-derives from the session_memories log (ground
//      truth), never from its own prior core-memory prose alone. Every pass
//      re-touches reality, so telephone-game drift can't form.
//
// Scope guard ("keep it dumb"): select / merge / mark superseded + one line of
// "why this carries." No salience scores, no decay, no propagation.

import { supabaseAdmin } from "./supabase.js";
import { stripModelTags } from "./sanitize.js";

const AI_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_MODEL =
  process.env.AI_MODEL || "nousresearch/hermes-3-llama-3.1-405b:free";

const NEW_MEMORY_THRESHOLD = 15; // fresh session_memories required to fire
const SESSION_LOG_LIMIT = 40;    // ground-truth window passed to reflection
const MAX_CORE = 7;              // cap the active set (model must choose, not accrete)

/**
 * Run a consolidation pass for a user if enough fresh material has arrived.
 * Fire-and-forget; never throws into the caller.
 *
 * @param {object} args
 * @param {string} args.userId
 */
export async function maybeConsolidate({ userId }) {
  try {
    if (!userId) return;
    // Kill switch (env). Default ON so it runs dark in prod, per spec.
    if (process.env.CONSOLIDATION === "off") return;

    // ── Trigger: fresh material only ──────────────────────────────────
    const { data: userRow } = await supabaseAdmin
      .from("users")
      .select("last_consolidated_at")
      .eq("id", userId)
      .single();

    const since = userRow?.last_consolidated_at || null;

    let countQuery = supabaseAdmin
      .from("session_memories")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (since) countQuery = countQuery.gt("created_at", since);

    const { count: newCount } = await countQuery;
    if (!newCount || newCount < NEW_MEMORY_THRESHOLD) return;

    // ── Ground truth: the session_memories log ────────────────────────
    const { data: sessions } = await supabaseAdmin
      .from("session_memories")
      .select("id, summary, frame_tag, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(SESSION_LOG_LIMIT);

    if (!sessions || sessions.length === 0) return;

    // ── Continuity context: current active core (split pinned) ────────
    const { data: activeCore } = await supabaseAdmin
      .from("core_memories")
      .select("id, text, pinned")
      .eq("user_id", userId)
      .eq("status", "active");

    const pinned = (activeCore || []).filter((c) => c.pinned);
    const unpinned = (activeCore || []).filter((c) => !c.pinned);

    // ── Reflect ───────────────────────────────────────────────────────
    const derived = await reflect({ sessions, pinned, unpinned });
    // null = transient failure → leave the marker so it retries next time.
    if (derived === null) return;
    if (derived.length === 0) {
      // Model legitimately surfaced nothing — advance the marker so we don't
      // re-run against the same frozen base every message.
      await supabaseAdmin
        .from("users")
        .update({ last_consolidated_at: new Date().toISOString() })
        .eq("id", userId);
      return;
    }

    const sessionIds = sessions.map((s) => s.id);
    const capped = derived.slice(0, MAX_CORE);

    // ── Supersede the old unpinned active set (pinned rows are immune) ─
    if (unpinned.length > 0) {
      await supabaseAdmin
        .from("core_memories")
        .update({ status: "superseded" })
        .in("id", unpinned.map((c) => c.id));
    }

    // ── Insert the re-derived set ─────────────────────────────────────
    const rows = capped.map((d) => ({
      user_id: userId,
      text: d.text,
      why_it_carries: d.why_it_carries || null,
      status: "active",
      pinned: false,
      source: "reflection",
      source_session_ids: sessionIds, // traceable to ground truth, can't be invented
    }));
    await supabaseAdmin.from("core_memories").insert(rows);

    // ── Advance the trigger marker ────────────────────────────────────
    await supabaseAdmin
      .from("users")
      .update({ last_consolidated_at: new Date().toISOString() })
      .eq("id", userId);
  } catch (e) {
    console.error("maybeConsolidate error:", e.message);
  }
}

// ─── Internal ───────────────────────────────────────────────────────

/**
 * One OpenRouter call. Returns [{ text, why_it_carries }] or null.
 * Anchors on the session log; uses current core only for continuity.
 */
async function reflect({ sessions, pinned, unpinned }) {
  const log = sessions
    .slice()
    .reverse() // chronological for the model
    .map((s) => `- (${s.frame_tag}) ${s.summary}`)
    .join("\n");

  const pinnedBlock = pinned.length
    ? "\nAlready pinned by the user (do NOT repeat or restate these):\n" +
      pinned.map((p) => `- ${p.text}`).join("\n")
    : "";
  const continuityBlock = unpinned.length
    ? "\nCurrent working set (for wording continuity only — keep what the sessions still support, drop what they don't):\n" +
      unpinned.map((u) => `- ${u.text}`).join("\n")
    : "";

  const system =
    "You maintain a short set of CORE MEMORIES about a person for a warm AI friend. " +
    "Re-derive the set ONLY from the SESSION LOG below (the ground truth). The current " +
    "working set is for wording continuity only — never invent anything the sessions don't support. " +
    `Choose the ${MAX_CORE} (or fewer) that genuinely carry — what matters to this person, ` +
    "what they keep returning to, what shifted for them. Weight breakthrough and challenge moments. " +
    "Frame everything warm and neutral: what matters to them, not a sad story about them. " +
    "Never crystallize a bleak read of someone. " +
    'Reply with ONLY a JSON array, no markdown: ' +
    '[{"text":"<one sentence, warm, second person or about them>","why_it_carries":"<short reason this one matters>"}]';

  const userMsg = `SESSION LOG (oldest to newest):\n${log}${pinnedBlock}${continuityBlock}`;

  const res = await fetch(AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://stoneheadai.com",
      "X-Title": "StoneHead AI",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      max_tokens: 500,
      temperature: 0.4,
      // No reasoning: keep the whole budget for the JSON array output.
      reasoning: { enabled: false },
    }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  let raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;
  // Strip code fences, then extract the JSON array — robust to any scaffold
  // wrapper or reasoning prefix. Inner tags are cleaned off each field below.
  raw = raw.replace(/```json|```/g, "").trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (jsonMatch) raw = jsonMatch[0];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((d) => ({
        text: d && d.text ? stripModelTags(String(d.text)).slice(0, 400) : "",
        why_it_carries: d && d.why_it_carries ? stripModelTags(String(d.why_it_carries)).slice(0, 300) : null,
      }))
      .filter((d) => d.text.trim());
  } catch {
    return null;
  }
}
