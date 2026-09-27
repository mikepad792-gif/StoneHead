// lib/photoStore.js
// Talk the Plant photo reads: the database half. The pure half is
// lib/photoRead.js.
//
// Every function takes the Supabase client as its first argument instead of
// importing lib/supabase.js, so importing this file never needs database env
// vars and nothing here runs at import time.
//
// Table: supabase/migrations/015_photo_reads.sql. Claim, release and quota:
// 019_passes_and_rollover.sql.

import { isFreshRead } from "./photoRead.js";

const USABLE = new Set(["ok", "not_cannabis", "unusable"]);

/**
 * Take one photo for today, atomically (claim_photo, migration 019): today's
 * allowance first, then rollover. Rollover is only drawn with
 * allow_rollover; without it the answer is needsConfirm and nothing is used.
 *
 * @returns {Promise<{ id: string|null, needsConfirm: boolean, photos: object|null, error: string|null }>}
 *   id null, needsConfirm false, no error: out of photos.
 */
export async function claimPhotoRead(db, { user_id, thread_id, daily_limit, paid_limit, allow_rollover = false }) {
  const { data, error } = await db.rpc("claim_photo", {
    p_user_id: user_id,
    p_thread_id: thread_id,
    p_daily_limit: daily_limit,
    p_paid_limit: paid_limit,
    p_allow_rollover: allow_rollover === true,
  });
  if (error) return { id: null, needsConfirm: false, photos: null, error: error.message || "claim failed" };
  return { id: data?.id || null, needsConfirm: data?.needs_confirm === true, photos: data?.photos || null, error: null };
}

/**
 * The photo quota, settled up to today (photo_quota, migration 019). Null
 * when it can't be read (say, 019 hasn't run): callers treat that as "don't
 * show counts", never as an error.
 */
export async function getPhotoQuota(db, { user_id, daily_limit, paid_limit }) {
  const { data, error } = await db.rpc("photo_quota", {
    p_user_id: user_id,
    p_daily_limit: daily_limit,
    p_paid_limit: paid_limit,
  });
  if (error) {
    console.error("photo quota failed (non-blocking):", error.message);
    return null;
  }
  return data || null;
}

/** Write the finished read onto its claimed row. */
export async function finishPhotoRead(db, id, { status, model, read, tokens_in, tokens_out }) {
  const { error } = await db
    .from("photo_reads")
    .update({ status, model, read, tokens_in: tokens_in || 0, tokens_out: tokens_out || 0 })
    .eq("id", id);
  if (error) console.error("photo read save failed:", error.message);
  return !error;
}

/**
 * Give a photo back. Used when the model call itself failed: OpenRouter does
 * not bill a failed request, so it should not cost the user a photo either.
 * release_photo only touches a row still pending, so it can never erase a
 * read that finished, and it returns the photo to the pile it came from
 * (today's allowance or rollover).
 */
export async function releasePhotoRead(db, id) {
  const { error } = await db.rpc("release_photo", { p_id: id });
  if (error) console.error("photo read release failed:", error.message);
}

/**
 * Everything chat-send needs to know about photos for one turn.
 *
 * Two lookups with deliberately different failure rules:
 *
 *  - The thread's EARLIER photo turns (which messages to label, and the last
 *    read for the one-turn carry). If this fails the turn degrades to "no
 *    photos": labels and the carry go quiet, the chat keeps working. Photos
 *    must never be able to take ordinary chat down.
 *
 *  - The read for THIS turn, when there is one. This one cannot degrade. A
 *    photo turn without its read would be StoneHead answering a photo nobody
 *    looked at, which is the exact thing the whole design exists to prevent.
 *
 * @returns {Promise<{
 *   photoMessageIds: Set<string>,
 *   lastLinked: object|null,
 *   turnRead: object|null,
 *   turnError: { status:number, code:string, error:string }|null
 * }>}
 */
export async function loadPhotoContext(db, { user_id, thread_id, photo_read_id, now = Date.now() }) {
  const ctx = { photoMessageIds: new Set(), lastLinked: null, turnRead: null, turnError: null };

  const { data: rows, error } = await db
    .from("photo_reads")
    .select("id, message_id, status, read, created_at")
    .eq("thread_id", thread_id)
    .eq("user_id", user_id)
    .not("message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("photo context lookup failed (non-blocking):", error.message);
  } else {
    for (const r of rows || []) ctx.photoMessageIds.add(r.message_id);
    ctx.lastLinked = (rows && rows[0]) || null;
  }

  if (photo_read_id) {
    const { data: row, error: rowError } = await db
      .from("photo_reads")
      .select("id, message_id, status, read, created_at")
      .eq("id", photo_read_id)
      .eq("user_id", user_id)
      .eq("thread_id", thread_id)
      .maybeSingle();
    if (rowError) {
      ctx.turnError = { status: 503, code: "photo_unavailable", error: "photo reads are unavailable" };
    } else if (!row) {
      ctx.turnError = { status: 404, code: "photo_not_found", error: "photo read not found" };
    } else if (row.message_id) {
      ctx.turnError = { status: 409, code: "photo_used", error: "that photo was already sent" };
    } else if (!USABLE.has(row.status)) {
      ctx.turnError = { status: 409, code: "photo_not_ready", error: "that photo read didn't finish" };
    } else if (!isFreshRead(row.created_at, now)) {
      ctx.turnError = { status: 410, code: "photo_expired", error: "that photo read expired" };
    } else {
      ctx.turnRead = row;
    }
  }

  return ctx;
}

/**
 * Mark a read as used by the user message it belongs to. The `is null`
 * filter makes a double submit link once, not twice.
 */
export async function linkPhotoRead(db, photoReadId, messageId) {
  const { error } = await db
    .from("photo_reads")
    .update({ message_id: messageId, used_at: new Date().toISOString() })
    .eq("id", photoReadId)
    .is("message_id", null);
  if (error) console.error("photo read link failed:", error.message);
}
