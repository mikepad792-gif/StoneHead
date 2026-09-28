-- 021_lock_client_writes.sql
-- Closes direct database writes from the app's public roles.
--
-- Every read and write in StoneHead goes through a Netlify function using the
-- service-role client (supabaseAdmin in lib/supabase.js), which skips these
-- rules entirely. The anon-key client only handles login. So the "own row"
-- write policies from migration 001 were never used by the app, and one of
-- them is a real hole: users_update_own lets a logged-in user change EVERY
-- column of their own users row through Supabase's REST API, using their
-- session token and the anon key. That includes is_subscribed and
-- subscription_expires (a free pass), is_founder, is_internal (skips the
-- refund cooldown), age_verified and self_reported_age_band, the daily
-- message count, and photo_rollover. messages_insert_own lets them write
-- replies StoneHead never said into their own threads, including threads
-- shared for training.
--
-- Also closes the gap migration 016 noted on 012: bump_bot_usage,
-- begin_bot_lookup and note_strain_shown were revoked from anon and
-- authenticated but not PUBLIC, and every role inherits PUBLIC's EXECUTE.
-- All three are only called through supabaseAdmin (api/strain-lookup.js).
--
-- Read policies stay: a user can still only ever see their own rows.
-- Safe to run again.

drop policy if exists "users_update_own"         on public.users;
drop policy if exists "threads_insert_own"       on public.threads;
drop policy if exists "threads_update_own"       on public.threads;
drop policy if exists "messages_insert_own"      on public.messages;
drop policy if exists "liked_strains_insert_own" on public.liked_strains;
drop policy if exists "liked_strains_delete_own" on public.liked_strains;
drop policy if exists "payment_codes_insert_own" on public.payment_codes;

-- Belt and braces: with no write privilege at all, a loose policy added
-- later can't reopen this.
revoke insert, update, delete, truncate
  on public.users, public.threads, public.messages,
     public.liked_strains, public.payment_codes
  from anon, authenticated;

revoke all on function public.bump_bot_usage(text, text, int, interval) from public, anon, authenticated;
grant execute on function public.bump_bot_usage(text, text, int, interval) to service_role;
revoke all on function public.begin_bot_lookup(text) from public, anon, authenticated;
grant execute on function public.begin_bot_lookup(text) to service_role;
revoke all on function public.note_strain_shown(text, text, int) from public, anon, authenticated;
grant execute on function public.note_strain_shown(text, text, int) to service_role;

-- Check afterwards. The first query should list only the *_select_own
-- policies; the second should say false on every row.
--
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public'
--    and tablename in ('users', 'threads', 'messages', 'liked_strains', 'payment_codes');
--
-- select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as can_run
--   from pg_proc p cross join (values ('anon'), ('authenticated')) r(rolname)
--  where p.proname in ('bump_bot_usage', 'begin_bot_lookup', 'note_strain_shown');
