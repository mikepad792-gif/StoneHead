#!/usr/bin/env node
// scripts/review-messages.mjs
// Operator CLI for reading conversations you are ALLOWED to read.
// Run: node scripts/review-messages.mjs [--thread <id>] [--limit <n>] [--since <ISO date>]
//
// Addendum A1. This exists so "point every review path at the view" is a real
// thing rather than an intention. It reads public.reviewable_messages, which
// only contains threads whose owner turned the data toggle ON.
//
// It also closes A1 point 4: the toggle write path had never been exercised by
// anything that read it back, so it was unproven in practice. Now flipping the
// toggle in the app changes what this prints.
//
// IF YOU NEED SOMETHING THIS WON'T SHOW YOU, that is the tool working. The raw
// public.messages table is still reachable with the service role, and the
// privacy policy says so in as many words — "a commitment about what I do, not
// a technical lock on what I'm able to do." Going around this should feel like
// a decision, because it is one.

import { supabaseAdmin } from "../lib/supabase.js";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const threadId = arg("thread");
const limit = Number(arg("limit", "50"));
const since = arg("since");

let query = supabaseAdmin
  .from("reviewable_messages")
  .select("thread_id, role, content, created_at")
  .order("created_at", { ascending: true })
  .limit(Number.isFinite(limit) && limit > 0 ? limit : 50);

if (threadId) query = query.eq("thread_id", threadId);
if (since) query = query.gte("created_at", since);

const { data, error } = await query;

if (error) {
  console.error("review-messages failed:", error.message);
  if (/relation .* does not exist/i.test(error.message)) {
    console.error(
      "\nThe reviewable_messages view is missing. Apply\n" +
      "supabase/migrations/009_reviewable_messages.sql first."
    );
  }
  process.exit(1);
}

if (!data.length) {
  console.log(
    "No reviewable messages.\n\n" +
    "That is the expected result when nobody has opted a thread in — the\n" +
    "toggle is off by default and most threads will never appear here."
  );
  process.exit(0);
}

let currentThread = null;
for (const m of data) {
  if (m.thread_id !== currentThread) {
    currentThread = m.thread_id;
    console.log(`\n─── thread ${currentThread} ───`);
  }
  const who = m.role === "user" ? "user " : "stone";
  console.log(`[${m.created_at}] ${who}: ${String(m.content).replace(/\n/g, "\n              ")}`);
}

console.log(
  `\n${data.length} message(s) from opted-in threads only. ` +
  "Threads with the toggle off are not in this view by construction."
);
