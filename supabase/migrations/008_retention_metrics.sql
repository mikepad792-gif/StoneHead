-- ============================================================
-- StoneHead AI — Migration 008: Retention instrumentation +
-- internal-account flag + founder metrics snapshot
--
-- Run this in Supabase BEFORE (or with) the code deploy that calls
-- bump_activity_day — the chat endpoint logs-and-continues if the
-- function is missing, but every day without the table is lost forever.
-- ============================================================

-- =========================
-- 1. user_activity_days
-- =========================
-- One row per user per active day. daily_message_count resets daily and
-- last_message_date holds only the most recent day — neither can
-- reconstruct a return pattern, so this table cannot be backfilled.
-- Counts EVERYONE, founders/internal included; dashboards exclude
-- internal accounts at query time via users.is_internal.
create table public.user_activity_days (
  user_id  uuid not null references public.users(id) on delete cascade,
  day      date not null,
  messages int  not null default 0,
  primary key (user_id, day)
);

create or replace function public.bump_activity_day(p_user_id uuid, p_day date)
returns void language sql as $$
  insert into public.user_activity_days (user_id, day, messages)
  values (p_user_id, p_day, 1)
  on conflict (user_id, day)
  do update set messages = public.user_activity_days.messages + 1;
$$;

-- RLS: enabled with NO client policies at all — service-role only, read and
-- write. Users never see this table (no streaks, no counters, nothing that
-- could leak into an engagement mechanic).
alter table public.user_activity_days enable row level security;

revoke all on table public.user_activity_days from anon, authenticated;
revoke execute on function public.bump_activity_day(uuid, date) from public, anon, authenticated;

-- =========================
-- 2. users.is_internal
-- =========================
-- The founder's own working account is a real row; unflagged it inflates
-- every metric by one in the flattering direction. Flag it, don't delete it.
alter table public.users add column is_internal boolean not null default false;
update public.users set is_internal = true where email = 'towflowapp@gmail.com';

-- =========================
-- 3. Metrics snapshot
-- =========================
-- Single service-role-only function returning every dashboard number.
-- EVERY metric filters is_internal = false — no exceptions. Messages and
-- tokens scope to non-internal users through the threads join.
create or replace function public.admin_metrics_snapshot()
returns jsonb
language sql
stable
as $$
with real_users as (
  select id from public.users where is_internal = false
),
activity as (
  select a.user_id, a.day
  from public.user_activity_days a
  join real_users u on u.id = a.user_id
),
firsts as (
  select user_id, min(day) as first_day
  from activity
  group by user_id
),
msgs as (
  select m.tokens_in, m.tokens_out
  from public.messages m
  join public.threads t on t.id = m.thread_id
  join real_users u on u.id = t.user_id
)
select jsonb_build_object(
  'total_users',      (select count(*) from real_users),
  'active_users_1d',  (select count(distinct user_id) from activity where day >= current_date),
  'active_users_7d',  (select count(distinct user_id) from activity where day > current_date - 7),
  'active_users_30d', (select count(distinct user_id) from activity where day > current_date - 30),
  -- count(*) from messages, NOT daily_message_count (which resets daily
  -- and would badly undercount)
  'total_messages',   (select count(*) from msgs),
  'tokens_in_total',  (select coalesce(sum(tokens_in),  0) from msgs),
  'tokens_out_total', (select coalesce(sum(tokens_out), 0) from msgs),
  -- Of users whose first activity day was >= N days ago, the fraction with
  -- an activity day >= N days after their first. null until any user is
  -- old enough to qualify.
  'day3_return', (
    select case when count(*) = 0 then null
      else round(count(*) filter (where returned)::numeric / count(*), 3) end
    from (
      select exists (
        select 1 from activity a
        where a.user_id = f.user_id and a.day >= f.first_day + 3
      ) as returned
      from firsts f
      where f.first_day <= current_date - 3
    ) s
  ),
  'day7_return', (
    select case when count(*) = 0 then null
      else round(count(*) filter (where returned)::numeric / count(*), 3) end
    from (
      select exists (
        select 1 from activity a
        where a.user_id = f.user_id and a.day >= f.first_day + 7
      ) as returned
      from firsts f
      where f.first_day <= current_date - 7
    ) s
  )
);
$$;

revoke execute on function public.admin_metrics_snapshot() from public, anon, authenticated;
