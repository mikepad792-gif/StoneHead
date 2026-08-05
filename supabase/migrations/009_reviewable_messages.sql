-- 009_reviewable_messages.sql
-- Addendum A1 — make the data toggle mean something.
--
-- THE PROBLEM THIS FIXES
-- api/threads-toggle-data.js wrote threads.data_opt_in and NOTHING anywhere
-- read it back. Not chat-send, not the postwork functions, not admin-metrics.
-- The privacy policy described it accurately — a permission record and a
-- conduct promise, not encryption — so the policy was not wrong. But the flag
-- constrained nothing.
--
-- This view converts the conduct promise into the default behavior of the
-- tooling: the reviewable surface is a different object from the raw table,
-- so reviewing an opted-OUT thread requires deliberately going around this
-- rather than merely forgetting to filter.
--
-- WHAT IT DOES NOT DO, AND THE POLICY SAYS SO
-- It does not remove administrative access to public.messages. Anyone with
-- the service role can still query the raw table. This is a default, not a
-- lock, and the privacy policy's wording ("a commitment about what I do, not
-- a technical lock on what I'm able to do") stays accurate and should not be
-- strengthened on account of this migration.
--
-- ENCRYPTION AT REST WAS CONSIDERED AND REJECTED (Addendum A1). Key custody
-- has no good answer at this scale, three background jobs need the plaintext,
-- and content goes to OpenRouter in the clear every turn regardless — so the
-- honest end state would be "encrypted in my database, transmitted in the
-- clear to a third party every message," which is weaker than what people
-- hear when you say "encrypted even to me."
--
-- ─────────────────────────────────────────────────────────────────────────
-- IF YOU ARE WRITING AN EXPORT, A DATASET SCRIPT, OR ANY NEW REVIEW QUERY:
-- read reviewable_messages, not messages. The whole point of this object is
-- that a year from now somebody writes `select * from messages` for a
-- perfectly good reason and silently breaks a promise made to every user who
-- left the toggle off. Join on the flag or use this view.
-- ─────────────────────────────────────────────────────────────────────────

create or replace view public.reviewable_messages as
select m.*
from public.messages m
join public.threads t on t.id = m.thread_id
where t.data_opt_in = true;

comment on view public.reviewable_messages is
  'Messages from threads whose owner turned the data toggle ON. The default '
  'surface for any human review, debugging of bad answers, export, or dataset '
  'work. Reading public.messages directly for those purposes bypasses a '
  'consent promise — see migration 009.';

-- The view is operator-facing only. It runs through the service role from
-- scripts/review-messages.mjs; end users have no reason to reach it, and RLS
-- on the underlying tables already scopes users to their own rows.
revoke all on public.reviewable_messages from public, anon, authenticated;
