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
