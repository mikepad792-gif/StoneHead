-- 013_bot_user_state.sql
-- Durable per-Discord-user state for the bot: whether it has introduced
-- itself, and which strains that person has already been shown.
--
-- WHY THIS RIDES ON bot_usage RATHER THAN A NEW TABLE
-- The row already exists, keyed by exactly the id these facts belong to
-- (scope 'user', key = discord_user_id), and it is already written on every
-- lookup by bump_bot_usage. A second table keyed the same way would mean a
-- second round trip inside a function budget that also has to fit a model
-- call.
--
-- The mix is worth naming, because the two kinds of column behave
-- differently: count and window_start are a COUNTER that resets every hour,
-- while the two added here are DURABLE and never reset. The row outlives the
-- window; only the counter inside it rolls over.
--
-- Both columns are meaningless on scope 'guild' rows and are simply never
-- read there.

alter table public.bot_usage
  add column if not exists intro_shown boolean not null default false;

alter table public.bot_usage
  add column if not exists recent_strains text[] not null default '{}';

comment on column public.bot_usage.intro_shown is
  'True once the bot has introduced itself to this Discord user. Claimed '
  'atomically by claim_bot_intro() so a burst of first lookups still only '
  'introduces once. Durable: unlike count, it never resets.';

comment on column public.bot_usage.recent_strains is
  'Most-recent-first list of strain names already shown to this user, capped '
  'by note_strain_shown(). Read to keep a no-match card from repeating a '
  'strain they have already seen.';

/*
 * Open a lookup: claim the intro if it has not been claimed, and return the
 * recent-strain list, in ONE round trip.
 *
 * Combined on purpose. This runs alongside the two rate-limit calls, inside a
 * function that must also fit an 8s model call inside Netlify's 10s ceiling,
 * so every avoidable round trip is worth avoiding.
 *
 * intro_claimed is true for exactly one caller. The UPDATE ... WHERE NOT
 * intro_shown is what makes that safe: two concurrent first lookups both
 * attempt it, Postgres serializes them on the row lock, and the second sees
 * intro_shown already true and returns false. A read-then-write in JS would
 * introduce twice.
 */
create or replace function public.begin_bot_lookup(p_user text)
returns table (intro_claimed boolean, recent text[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
  v_recent text[] := '{}';
begin
  -- Ensure the row exists so the claim below has something to lock. A user's
  -- very first lookup may reach here before bump_bot_usage has inserted.
  insert into public.bot_usage (scope, key, window_start, count)
  values ('user', p_user, now(), 0)
  on conflict (scope, key) do nothing;

  update public.bot_usage
     set intro_shown = true
   where scope = 'user'
     and key = p_user
     and not intro_shown
  returning true into v_claimed;

  select bot_usage.recent_strains into v_recent
    from public.bot_usage
   where scope = 'user' and key = p_user;

  return query select coalesce(v_claimed, false), coalesce(v_recent, '{}');
end;
$$;

comment on function public.begin_bot_lookup is
  'Atomically claim the one-time intro and return this user''s recently shown '
  'strains. One round trip because the endpoint has a model call to fit — see '
  'migration 013.';

/*
 * Record that a strain was shown, keeping the newest p_keep names.
 *
 * Deduplicates first, so re-showing a strain moves it to the front rather
 * than occupying two slots and pushing something else out early.
 */
create or replace function public.note_strain_shown(
  p_user text,
  p_strain text,
  p_keep int default 20
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bot_usage (scope, key, window_start, count, recent_strains)
  values ('user', p_user, now(), 0, array[p_strain])
  on conflict (scope, key) do update
    set recent_strains =
      (array[p_strain] || array_remove(bot_usage.recent_strains, p_strain))[1:p_keep];
end;
$$;

comment on function public.note_strain_shown is
  'Push a strain onto this user''s recently-shown list, newest first, capped '
  'at p_keep. Used to keep a no-match card from repeating — see migration 013.';

-- Same posture as 012: reached only by the service-role client inside the
-- endpoint, so the PostgREST roles get nothing.
revoke all on function public.begin_bot_lookup(text) from anon, authenticated;
revoke all on function public.note_strain_shown(text, text, int) from anon, authenticated;
