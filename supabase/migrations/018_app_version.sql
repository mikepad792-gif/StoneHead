-- 018_app_version.sql
-- Which StoneHead version produced each message, each rating, and each
-- data-toggle consent. NULL on older rows means "before versioning" (1.5.8
-- or earlier). The version itself lives in src/version.js.

alter table public.messages
  add column if not exists app_version text;

alter table public.message_feedback
  add column if not exists app_version text;

alter table public.threads
  add column if not exists data_opt_in_version text;

-- reviewable_messages was created as "select m.*", but a view's column list
-- is fixed when it's created: the new column doesn't appear until the view
-- is replaced. Same definition as 009, re-run:
create or replace view public.reviewable_messages as
select m.*
from public.messages m
join public.threads t on t.id = m.thread_id
where t.data_opt_in = true;

revoke all on public.reviewable_messages from public, anon, authenticated;

-- reviewable_feedback (017): same columns in the same order, plus two at the
-- end (a replaced view can only gain columns at the end).
create or replace view public.reviewable_feedback as
select f.id, f.rating, f.comment, f.training_ok, f.created_at,
       t.tab,
       prev.content as user_message,
       m.content    as reply,
       m.app_version as reply_version,     -- which StoneHead wrote the rated reply
       f.app_version as rated_on_version   -- which version they rated it on
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
