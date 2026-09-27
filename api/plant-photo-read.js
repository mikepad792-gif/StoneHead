// api/plant-photo-read.js
// POST /api/plant/photo-read
//
// Step one of a Talk the Plant photo turn: look at the photo, store a text
// read of it, hand back an id. Step two is api/chat-send.js with that id,
// which is where StoneHead actually replies. See lib/photoRead.js for why a
// photo turn is two requests.
//
// Request:  { thread_id, image: "data:image/jpeg;base64,...", caption?, allow_rollover? }
// Response: 200 { status: "ok"|"not_cannabis"|"unusable", photo_read_id, photos_remaining, photos }
//           409 { code: "rollover_confirm", photos }  today's photos are used
//               up and the next one would come from rollover; resend with
//               allow_rollover: true once the user says okay
//           429 { code: "photo_limit", photos }  nothing left at all
//           photos is the quota after this request (migration 019).
//           200 { status: "skipped", reason: "safety"|"message_limit" }
//               The client sends the turn to chat-send WITHOUT a photo, and
//               chat-send answers it the way it answers any text turn.
//           4xx/5xx { error, code }
//
// Model:  AI_MODEL_VISION (Claude by default), same OPENROUTER_API_KEY as
//         everything else. Never AI_MODEL: that is a text-only model.
// Stores: a photo_reads row (migration 015). Never the image.
//
// Order matters below, and it follows chat-send's: cheap refusals first,
// safety before any spend, the cap claim right before the one call that
// costs money.

import { authenticateRequest, errorResponse, jsonResponse } from "../lib/auth.js";
import { supabaseAdmin } from "../lib/supabase.js";
import { FREE_DAILY_LIMIT } from "../lib/constants.js";
import { blocksCannabis } from "../lib/ageDetect.js";
import { detectCrisis } from "../lib/crisisDetect.js";
import { detectSubstance } from "../lib/substanceDetect.js";
import { openrouterChat } from "../lib/openrouter.js";
import {
  AI_MODEL_VISION,
  AI_MODEL_VISION_FALLBACK,
  OPENROUTER_TIMEOUT_VISION_MS,
} from "../lib/config.js";
import {
  CAPTION_MAX,
  parseImageDataUrl,
  stripJpegMetadata,
  toJpegDataUrl,
  buildReaderMessages,
  parseReaderReply,
  normalizeRead,
} from "../lib/photoRead.js";
import { claimPhotoRead, finishPhotoRead, releasePhotoRead } from "../lib/photoStore.js";
import { isUnlimited, photoLimits } from "../lib/passStatus.js";
import { allIssues, knownIssueIds } from "../lib/cultivationSearch.js";

// The read is short JSON. 500 is a ceiling with room, not a target: a
// truncated read is an unparseable read, and that costs the user a photo.
const VISION_MAX_TOKENS = 500;

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return errorResponse(405, "Method not allowed");
  }

  const auth = await authenticateRequest(event);
  if (auth.error) {
    return errorResponse(401, auth.error);
  }
  const { user_id } = auth;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body", code: "bad_request" });
  }

  const { thread_id } = body;
  if (!thread_id || typeof thread_id !== "string") {
    return jsonResponse(400, { error: "thread_id is required", code: "bad_request" });
  }
  const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, CAPTION_MAX) : "";
  const allow_rollover = body.allow_rollover === true;

  // Validate the image before touching the database or anyone's quota.
  const image = parseImageDataUrl(body.image);
  if (!image.ok) {
    return jsonResponse(400, { error: image.error, code: "bad_image" });
  }

  try {
    // ── The thread: theirs, and a plant thread ──────────────────────
    // Photos are a Talk the Plant feature, enforced here and not just by the
    // button only rendering on that tab.
    const { data: thread, error: threadError } = await supabaseAdmin
      .from("threads")
      .select("id, tab")
      .eq("id", thread_id)
      .eq("user_id", user_id)
      .single();
    if (threadError || !thread) {
      return jsonResponse(404, { error: "Thread not found", code: "thread_not_found" });
    }
    if (thread.tab !== "plant") {
      return jsonResponse(409, { error: "Photos are only read on Talk the Plant", code: "not_plant" });
    }

    // ── The user: age gates and limits ──────────────────────────────
    const { data: user, error: userError } = await supabaseAdmin
      .from("users")
      .select("daily_message_count, last_message_date, is_subscribed, subscription_expires, is_founder, age_verified, self_reported_age_band")
      .eq("id", user_id)
      .single();
    if (userError || !user) {
      return jsonResponse(404, { error: "User not found", code: "user_not_found" });
    }

    // Same two gates threads-create applies to the plant tab. A photo read is
    // the most expensive call in the app, so it gets checked on the server
    // every time instead of trusting that the tab was opened legitimately.
    if (blocksCannabis(user.self_reported_age_band)) {
      return jsonResponse(403, { error: "Talk the Plant is 21+", code: "age_blocked" });
    }
    if (!user.age_verified) {
      return jsonResponse(403, { error: "Age verification required for Talk the Plant", code: "age_unverified" });
    }

    // ── Safety before spend ─────────────────────────────────────────
    // A caption that trips the crisis or substance intercept is chat-send's
    // to handle, and in that state chat-send ignores photos anyway. So no
    // vision call, and nothing about this person's worst moment goes to a
    // model running a plant-reading prompt. History-free on purpose: this is
    // a spend guard, not the safety decision. chat-send makes that one, with
    // history.
    if (caption && (detectCrisis(caption, []).tier >= 1 || detectSubstance(caption).tier >= 1)) {
      return jsonResponse(200, { status: "skipped", reason: "safety" });
    }

    // ── Out of messages: chat-send will say so, don't pay for a read ──
    const today = new Date().toISOString().split("T")[0];
    const unlimited = isUnlimited(user);
    const messagesToday = user.last_message_date === today ? user.daily_message_count || 0 : 0;
    if (!unlimited && messagesToday >= FREE_DAILY_LIMIT) {
      return jsonResponse(200, { status: "skipped", reason: "message_limit" });
    }

    // ── Claim a photo (atomic, migration 019) ───────────────────────
    // Today's allowance first, then rollover, and rollover only once the
    // user has said okay to it (allow_rollover).
    const { daily_limit, paid_limit } = photoLimits(user);
    const claim = await claimPhotoRead(supabaseAdmin, {
      user_id,
      thread_id,
      daily_limit,
      paid_limit,
      allow_rollover,
    });
    if (claim.error) {
      // Most likely cause: migration 019 hasn't been run.
      console.error("photo read claim failed:", JSON.stringify({ thread_id, error: claim.error }));
      return jsonResponse(503, { error: "Photo reads are unavailable", code: "photo_unavailable" });
    }
    if (claim.needsConfirm) {
      return jsonResponse(409, { error: "This uses a rollover photo", code: "rollover_confirm", photos: claim.photos });
    }
    if (!claim.id) {
      return jsonResponse(429, { error: "Daily photo limit reached", code: "photo_limit", photos_remaining: 0, photos: claim.photos });
    }
    const photos = claim.photos;
    const photos_remaining = photos ? photos.remaining_today : null;

    // ── Strip metadata, then look ───────────────────────────────────
    // The client's canvas redraw already removed EXIF. This is the second
    // lock: GPS coordinates must not leave this function no matter which
    // client sent the file.
    const clean = stripJpegMetadata(image.bytes);
    if (!clean) {
      await releasePhotoRead(supabaseAdmin, claim.id);
      return jsonResponse(400, { error: "Couldn't read that image", code: "bad_image" });
    }

    const messages = buildReaderMessages({
      caption,
      imageDataUrl: toJpegDataUrl(clean),
      issues: allIssues(),
    });

    const aiData = await openrouterChat(
      AI_MODEL_VISION,
      messages,
      {
        // An observation, not a riff. Same read for the same photo.
        temperature: 0,
        max_tokens: VISION_MAX_TOKENS,
        // No hidden thinking: it adds seconds this synchronous function does
        // not have, and the read is a checklist, not a proof.
        reasoning: { enabled: false },
        provider: {
          // Among the providers serving this model, prefer the quickest to
          // answer. They bill the same model at the same rate, apart from a
          // few regional endpoints.
          sort: "latency",
          // Only providers that don't keep or train on what's sent. A photo
          // of someone's grow is exactly the kind of input the privacy
          // policy's training section is about. Anthropic's endpoints all
          // qualify; if AI_MODEL_VISION is ever pointed at a model with no
          // qualifying provider, the read fails closed instead of routing to
          // one that trains.
          data_collection: "deny",
        },
      },
      {
        timeoutMs: OPENROUTER_TIMEOUT_VISION_MS,
        fallbackModel: AI_MODEL_VISION_FALLBACK,
      }
    );

    if (!aiData) {
      // OpenRouter does not bill a failed request, so the user shouldn't pay
      // a photo for it either.
      await releasePhotoRead(supabaseAdmin, claim.id);
      return jsonResponse(502, { error: "Couldn't read the photo right now", code: "vision_unavailable" });
    }

    const model = aiData.model || AI_MODEL_VISION;
    const tokens_in = aiData.usage?.prompt_tokens || 0;
    const tokens_out = aiData.usage?.completion_tokens || 0;
    const raw = aiData.choices?.[0]?.message?.content || "";
    const read = normalizeRead(parseReaderReply(raw), knownIssueIds());

    if (!read) {
      // The model answered but not in a shape we can trust. This one WAS
      // billed, so the row stays and counts. The raw text is kept (it is a
      // description of a plant, never the image) so the failure can be
      // diagnosed, and the review view still gates who looks at it.
      await finishPhotoRead(supabaseAdmin, claim.id, {
        status: "error",
        model,
        read: { raw: String(raw).slice(0, 2000) },
        tokens_in,
        tokens_out,
      });
      console.error("photo read unparseable:", JSON.stringify({ thread_id, model, raw_len: raw.length }));
      return jsonResponse(502, { error: "Couldn't make sense of that photo", code: "vision_unreadable" });
    }

    if (read.dropped_ids.length) {
      // The reader named something the reference doesn't have. It was
      // removed before storage, but the rate is worth knowing.
      console.warn("photo read dropped unknown ids:", JSON.stringify({ thread_id, model, dropped: read.dropped_ids }));
    }

    const saved = await finishPhotoRead(supabaseAdmin, claim.id, {
      status: read.status,
      model,
      read,
      tokens_in,
      tokens_out,
    });
    if (!saved) {
      return jsonResponse(500, { error: "Couldn't save the photo read", code: "photo_unavailable" });
    }

    return jsonResponse(200, {
      status: read.status,
      photo_read_id: claim.id,
      photos_remaining,
      photos,
    });
  } catch (err) {
    console.error("plant/photo-read error:", err);
    return jsonResponse(500, { error: "Internal server error", code: "server_error" });
  }
}
