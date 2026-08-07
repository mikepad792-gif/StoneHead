-- 011_tos_acceptance.sql
-- One-time terms + privacy acknowledgement, for every account old and new.
--
-- WHY A VERSION AND NOT JUST A BOOLEAN
-- The Terms already promise "if I change these terms meaningfully, I'll say so
-- in the app and in the Discord." A boolean can only ever answer "have they
-- ever accepted anything"; a version answers "have they accepted THIS," which
-- is what that promise actually requires. Bump TOS_VERSION in
-- lib/constants.js and everyone sees the modal again — a boolean would need a
-- migration to reset, and the reset would be indistinguishable from a bug.
--
-- WHY THE TIMESTAMP TOO
-- If somebody ever asks what they agreed to and when, "2026-08-07, version
-- 2026-08-05" is an answer. NULL in both columns means they have never been
-- asked, which is the state every existing account starts in.

alter table public.users
  add column if not exists tos_accepted_at timestamptz;

alter table public.users
  add column if not exists tos_version text;

comment on column public.users.tos_accepted_at is
  'When the user accepted the terms and privacy policy. NULL = never asked, '
  'which is where every account created before migration 011 starts.';

comment on column public.users.tos_version is
  'Which version they accepted, matched against TOS_VERSION in '
  'lib/constants.js. A mismatch re-prompts — see migration 011.';
