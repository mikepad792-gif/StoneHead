// lib/constants.js
// Shared constants for StoneHead AI
// FREE_DAILY_LIMIT must match the value in profile/get.js (Thread 1)

export const FREE_DAILY_LIMIT = 50;

// Default thread titles a thread can still be sitting on before it gets a
// generated topic title. Used by the lazy-retry check in chat-send.js and
// the one-off api/backfill-titles.js sweep. Includes the original DB default
// ("New Thread") plus the per-tab defaults set in threads-create.js.
export const DEFAULT_TITLES = ["New Thread", "new vibe", "new plant chat"];

// In-character line served when the model returned nothing usable. Stored in
// the thread like any assistant message, so downstream consumers (the title
// generator) need the exact string to filter it back OUT of transcripts —
// it describes an infrastructure hiccup, not the conversation.
export const BLANK_REPLY_FALLBACK = "...bro I just blanked. say that again?";
