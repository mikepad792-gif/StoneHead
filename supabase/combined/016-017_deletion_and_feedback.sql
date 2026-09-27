-- Migrations 016 and 017 in one paste, for a project that has already run
-- 001 through 015. One transaction: if anything fails, nothing is applied.
begin;

-- ================================================================
-- 016_account_deletion.sql
-- ================================================================
-- 016_account_deletion.sql
-- In-app account deletion (api/account-delete.js).
--
-- Every user-owned table cascades from users(id), so deleting that one row
-- removes everything. The single exception is session-memory summaries from
-- threads where the user turned the data toggle ON: those are COPIED OUT
-- first into retained_memories, stripped of every link back to the person.
--
-- A copy, not a looser foreign key: switching session_memories to
-- ON DELETE SET NULL would also leave memories behind when someone deletes a
-- single thread, which is a different promise.

create table if not exists public.retained_memories (
  id             uuid primary key default gen_random_uuid(),
  summary        text not null,
  frame_tag      text,
  tab            text,
  message_count  integer,
  created_month  date,          -- month only, not the exact time
  retained_at    timestamptz not null default now()
);

comment on table public.retained_memories is
  'Session-memory summaries from data-toggle-ON threads, kept after their '
  'owner deleted the account. No user_id, no thread_id, no original id: '
  'nothing here links back to a person. Filled only by delete_account().';

alter table public.retained_memories enable row level security;
-- No policies on purpose: service role only.
revoke all on public.retained_memories from public, anon, authenticated;

create or replace function public.delete_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retained integer := 0;
  v_deleted  integer := 0;
begin
  -- 1. Copy out the shared memories, stripped of every link.
  insert into public.retained_memories
    (summary, frame_tag, tab, message_count, created_month)
  select sm.summary, sm.frame_tag, sm.tab, sm.message_count,
         date_trunc('month', sm.created_at)::date
  from public.session_memories sm
  join public.threads t on t.id = sm.thread_id
  where sm.user_id = p_user_id
    and t.data_opt_in = true;
  get diagnostics v_retained = row_count;

  -- 2. Delete the root row. Every user table cascades from here.
  delete from public.users where id = p_user_id;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('retained', v_retained, 'deleted', v_deleted > 0);
end;
$$;

-- Revoke from PUBLIC too, not just anon/authenticated: Postgres grants
-- EXECUTE on new functions to PUBLIC by default (the gap noted on 012).
revoke all on function public.delete_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_account(uuid) to service_role;


-- ================================================================
-- 017_message_feedback.sql
-- ================================================================
-- 017_message_feedback.sql
-- Thumbs up / down on StoneHead replies (api/feedback.js).
--
-- One row per (user, reply). Everything cascades from users, threads and
-- messages, so deleting a thread or the account (016) removes its ratings.

create table if not exists public.message_feedback (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  thread_id    uuid not null references public.threads(id) on delete cascade,
  message_id   uuid not null references public.messages(id) on delete cascade,
  rating       text not null check (rating in ('up', 'down')),
  comment      text check (comment is null or char_length(comment) <= 1000),
  training_ok  boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, message_id)
);

create index if not exists idx_message_feedback_thread on public.message_feedback(thread_id);

alter table public.message_feedback enable row level security;
revoke all on public.message_feedback from public, anon, authenticated;

alter table public.users
  add column if not exists skip_training_prompt boolean not null default false;

-- Review surface: every rated exchange, with the reply and the user message
-- right before it. Rating is explicit consent to review that one exchange,
-- so this view does NOT filter on data_opt_in (see the thumbs-down copy).
-- Dropped first so this file can be re-run after 018, which adds columns to
-- this view (create or replace can't take columns away). It's only a view:
-- 018 rebuilds it with the version columns.
drop view if exists public.reviewable_feedback;
create view public.reviewable_feedback as
select f.id, f.rating, f.comment, f.training_ok, f.created_at,
       t.tab,
       prev.content as user_message,
       m.content    as reply
from public.message_feedback f
join public.messages m on m.id = f.message_id
join public.threads  t on t.id = f.thread_id
left join lateral (
  select p.content from public.messages p
  where p.thread_id = m.thread_id
    and p.role = 'user'
    and p.created_at < m.created_at
  order by p.created_at desc
  limit 1
) prev on true;

revoke all on public.reviewable_feedback from public, anon, authenticated;


commit;
