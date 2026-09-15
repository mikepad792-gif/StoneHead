-- 012_bot_usage.sql
-- Rate-limit counters for the public Discord lookup endpoint
-- (api/strain-lookup.js).
--
-- WHY A TABLE AND NOT AN IN-MEMORY COUNTER
-- Netlify runs each invocation in its own short-lived container. A module-level
-- Map resets on every cold start and is never shared between warm ones, so an
-- in-process counter on a serverless endpoint is not a rate limit — it's a
-- variable that occasionally happens to be right.
--
-- WHY THE INCREMENT LIVES IN THE DATABASE
-- Read-then-write from JS leaks under exactly the burst the limit exists for:
-- two concurrent requests both read count = 99, both decide they're under the
-- cap, and both write 100. bump_bot_usage does it in ONE statement, so Postgres
-- takes a row lock and the increment cannot interleave.
--
-- WHAT IS STORED
-- A Discord snowflake and a count. No message text, no usernames, nothing that
-- outlives the hour it was counted in. The endpoint writes here and nowhere
-- else — see the header of api/strain-lookup.js.

create table if not exists public.bot_usage (
  scope        text not null,        -- 'user' | 'guild'
  key          text not null,        -- the discord id, or 'dm:<user id>'
  window_start timestamptz not null default now(),
  count        int not null default 0,
  primary key (scope, key)
);

comment on table public.bot_usage is
  'Hourly rate-limit counters for the Discord strain-lookup endpoint. '
  'Written only by bump_bot_usage(). Rows are counters, not history — see '
  'migration 012.';

comment on column public.bot_usage.key is
  'Discord user or guild snowflake. DMs have no guild id, so the guild-scope '
  'row for a DM is keyed dm:<discord_user_id>, which keeps one person''s DMs '
  'from spending a bucket every other DM user also lands in.';

-- No RLS policies on purpose: this table is reached ONLY by the service-role
-- client inside the endpoint. Enabling RLS with no policy denies anon and
-- authenticated outright, which is the intended access for a counter that no
-- browser session has any business reading.
alter table public.bot_usage enable row level security;

/*
 * Bump one counter and report whether it is still inside its cap.
 *
 * Returns TRUE while the caller is under the limit, FALSE once over. The
 * window reset is folded into the same statement as the increment, so there
 * is no separate "is it a new hour yet" check to race against.
 *
 * @param p_scope  'user' or 'guild'
 * @param p_key    the discord id
 * @param p_limit  max requests per window
 * @param p_window window length (default 1 hour)
 */
create or replace function public.bump_bot_usage(
  p_scope text,
  p_key text,
  p_limit int,
  p_window interval default '1 hour'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count int;
begin
  insert into public.bot_usage (scope, key, window_start, count)
  values (p_scope, p_key, now(), 1)
  on conflict (scope, key) do update
    set count = case
          when bot_usage.window_start < now() - p_window then 1
          else bot_usage.count + 1
        end,
        window_start = case
          when bot_usage.window_start < now() - p_window then now()
          else bot_usage.window_start
        end
  returning count into new_count;

  return new_count <= p_limit;   -- false = over the cap
end;
$$;

comment on function public.bump_bot_usage is
  'Atomically increment a bot_usage counter and return whether the caller is '
  'still under p_limit. Single-statement upsert so concurrent Netlify '
  'invocations cannot both pass a check they should not — see migration 012.';

-- The counter is reached through the service-role client only. Revoke the
-- roles PostgREST exposes so a leaked anon key cannot spend somebody's quota
-- for them.
revoke all on function public.bump_bot_usage(text, text, int, interval) from anon, authenticated;
