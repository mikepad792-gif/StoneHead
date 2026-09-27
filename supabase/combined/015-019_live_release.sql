-- Migrations 015 through 019 in one paste, for a project that has run 001-014
-- (the live site before 2.0). 015 photo reads, 016 delete my account, 017
-- reply thumbs, 018 app version, 019 passes and rollover (with refunds).
-- One transaction: if anything fails, nothing is applied. Safe to run again,
-- and safe on a project that already ran some of these.
-- Run it BEFORE deploying the code.
begin;

-- ================================================================
-- 015_photo_reads.sql
-- ================================================================
-- 015_photo_reads.sql
-- Talk the Plant photo reads.
--
-- RUN THIS BEFORE DEPLOYING THE CODE THAT USES IT. Nothing breaks for ordinary
-- chat if you forget (see "why messages does not get a column" below), but
-- every photo send fails until it exists.
--
-- WHAT IS STORED
-- A structured TEXT read of what the vision model saw in a grow photo, which
-- model produced it, and token counts. NOT THE PHOTO. The image exists in one
-- Netlify function's memory for the length of one request and is never
-- written anywhere: not this table, not storage, not logs.
--
-- WHY A TABLE
-- 1. It is the handoff. api/plant-photo-read.js writes the read and hands the
--    client an id; api/chat-send.js loads the read by that id, scoped to the
--    same user and thread. The read itself never round-trips through the
--    browser, so a client cannot hand chat-send a "read" it wrote itself.
-- 2. It is the daily cap. claim_photo_read() counts and inserts in one call
--    under a row lock, for the same reason bump_bot_usage exists (migration
--    012): read-then-write from JS leaks under exactly the burst a cap is for.
-- 3. It marks which messages were photos (message_id), so the UI can show a
--    photo marker on reload and chat-send can label those turns for the model.
--
-- WHY messages DOES NOT GET A COLUMN
-- chat-send and threads-messages select from messages on every request. A new
-- column there turns "forgot to run the migration" into "every chat is down".
-- Hanging the link off this table instead means a missing migration breaks
-- photo reads and nothing else.

create table if not exists public.photo_reads (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.users(id) on delete cascade,
  thread_id   uuid not null references public.threads(id) on delete cascade,
  message_id  uuid references public.messages(id) on delete set null,
  status      text not null default 'pending'
              check (status in ('pending', 'ok', 'not_cannabis', 'unusable', 'error')),
  model       text,
  read        jsonb,
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

comment on table public.photo_reads is
  'Text reads of Talk the Plant photos. Never the image itself. Written by '
  'api/plant-photo-read.js, consumed and linked by api/chat-send.js. For any '
  'human review, read reviewable_photo_reads, not this table. See migration 015.';

comment on column public.photo_reads.read is
  'Normalized vision output (status, subject, observations, matches against '
  'cultivation.issues.json ids, ask). Invented ids are removed before storage '
  'and listed in dropped_ids. On a parse failure: {"raw": first 2000 chars}.';

comment on column public.photo_reads.message_id is
  'The user message this read was sent with. NULL until chat-send uses it. '
  'A read older than 15 minutes that was never linked is dead weight.';

create index if not exists idx_photo_reads_user_created
  on public.photo_reads (user_id, created_at desc);

create index if not exists idx_photo_reads_thread_created
  on public.photo_reads (thread_id, created_at desc);

-- No RLS policies on purpose, same as bot_usage: this table is reached only
-- through the service-role client inside the functions. RLS with no policy
-- denies anon and authenticated outright.
alter table public.photo_reads enable row level security;

/*
 * Claim one photo slot, or report that the user is at the cap.
 *
 * Returns {"id": <new row id>, "used": n} on success, or
 * {"id": null, "used": n} when n already reached p_limit.
 *
 * The FOR UPDATE on the user's row is the whole point. It serializes one
 * user's concurrent claims, so two requests cannot both count 4 of 5 and both
 * insert. The lock lasts for this call's transaction only (milliseconds).
 *
 * Every row counts, finished or not, except rows the endpoint deleted
 * because the model call failed (a failed OpenRouter request is not billed,
 * so it is not charged against the user either).
 *
 * @param p_user_id   the user
 * @param p_thread_id the plant thread the photo was sent in
 * @param p_limit     reads allowed since p_since
 * @param p_since     start of the counting window (UTC midnight, from JS)
 */
create or replace function public.claim_photo_read(
  p_user_id uuid,
  p_thread_id uuid,
  p_limit int,
  p_since timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  used int;
  new_id uuid;
begin
  perform 1 from public.users where id = p_user_id for update;

  select count(*) into used
    from public.photo_reads
   where user_id = p_user_id
     and created_at >= p_since;

  if used >= p_limit then
    return jsonb_build_object('id', null, 'used', used);
  end if;

  insert into public.photo_reads (user_id, thread_id)
  values (p_user_id, p_thread_id)
  returning id into new_id;

  return jsonb_build_object('id', new_id, 'used', used + 1);
end;
$$;

comment on function public.claim_photo_read is
  'Atomically check the daily photo cap and claim a photo_reads row. '
  'Row-locks the user so concurrent claims cannot both pass. See migration 015.';

-- Service role only. PUBLIC is in the list on purpose: Postgres grants EXECUTE
-- on new functions to PUBLIC by default, and every role (anon included)
-- inherits from PUBLIC, so revoking from anon and authenticated alone would
-- leave the door open.
revoke all on function public.claim_photo_read(uuid, uuid, int, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_photo_read(uuid, uuid, int, timestamptz)
  to service_role;

-- The review surface, same rule as reviewable_messages (migration 009). A
-- photo read describes somebody's grow, so looking through reads to judge the
-- vision model's quality follows the same data toggle as looking through
-- messages. Read this view, not the table, for that work.
create or replace view public.reviewable_photo_reads as
select pr.*
from public.photo_reads pr
join public.threads t on t.id = pr.thread_id
where t.data_opt_in = true;

comment on view public.reviewable_photo_reads is
  'Photo reads from threads whose owner turned the data toggle ON. The default '
  'surface for reviewing vision quality. See migrations 009 and 015.';

revoke all on public.reviewable_photo_reads from public, anon, authenticated;

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

-- ================================================================
-- 018_app_version.sql
-- ================================================================
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

-- ================================================================
-- 019_passes_and_rollover.sql
-- ================================================================
-- 019_passes_and_rollover.sql
-- StoneHead 2.1: Stripe passes, per-day photo usage, and rollover photos.
--
--   pass_purchases  one row per completed Stripe Checkout Session
--   photo_usage     photos used per user per UTC day. NOT tied to threads:
--                   counting photo_reads (which cascade from threads) meant
--                   deleting a thread refunded that day's photos.
--   users           rollover bank, its two settle markers, warn_rollover,
--                   and legacy_pass_until (see below)
--   photo_reads     which pile each claimed read came from, for refunds
--   revoke_pass     a fully refunded pass is taken back (Stripe charge.refunded)
--
-- Rollover is settled on demand (settle_rollover), never by a scheduled job.
-- lib/rolloverMath.js is a line-for-line JS copy of the replay, tested by
-- scripts/rollover-check.mjs. Change both together.
--
-- The old claim_photo_read (015) stays until the new code is deployed, so
-- deploy order doesn't matter. A later migration drops it.

create table if not exists public.pass_purchases (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  stripe_session_id  text not null unique,
  pass               text not null check (pass in ('7day', '30day')),
  days               int  not null check (days > 0),
  amount_cents       int,
  currency           text,
  starts_at          timestamptz not null,
  ends_at            timestamptz not null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_pass_purchases_user on public.pass_purchases(user_id, ends_at);

-- Refunds. Added as ALTERs (not in the CREATE above) so re-running this file
-- on a database that already ran an earlier copy of 019 still adds them.
--   stripe_payment_intent  what a Stripe refund (charge.refunded) points at
--   refunded_at            set by revoke_pass; a refunded pass counts for nothing
alter table public.pass_purchases
  add column if not exists stripe_payment_intent text,
  add column if not exists refunded_at           timestamptz;
create index if not exists idx_pass_purchases_payment_intent on public.pass_purchases(stripe_payment_intent);

create table if not exists public.photo_usage (
  user_id        uuid not null references public.users(id) on delete cascade,
  day            date not null,
  used_daily     int  not null default 0,
  used_rollover  int  not null default 0,
  primary key (user_id, day)
);

alter table public.users
  add column if not exists photo_rollover          int     not null default 0,
  add column if not exists rollover_halved_through date,
  add column if not exists rollover_credit_through date,
  add column if not exists warn_rollover           boolean not null default true,
  add column if not exists legacy_pass_until       timestamptz;

-- Subscribers from before passes existed. subscription_expires can't stand in
-- for "was paid on day d" once passes exist: grant_pass moves it to the new
-- pass's end, which would make every earlier free day look paid. So the old
-- end date is copied once, here, and only that copy counts as a legacy pass.
update public.users
   set legacy_pass_until = subscription_expires
 where legacy_pass_until is null
   and is_subscribed = true
   and subscription_expires > now();

alter table public.photo_reads
  add column if not exists source    text check (source in ('daily', 'rollover')),
  add column if not exists usage_day date;

alter table public.pass_purchases enable row level security;
alter table public.photo_usage    enable row level security;
revoke all on public.pass_purchases from public, anon, authenticated;
revoke all on public.photo_usage    from public, anon, authenticated;

-- ── grant_pass ──────────────────────────────────────────────────────
-- Called by the Stripe webhook. Idempotent on the Checkout Session id, so a
-- webhook retry never grants twice. Stacks: a pass bought while one is active
-- starts when the current one ends.
-- The payment intent joined the signature for refunds; drop the older
-- six-argument version if an earlier copy of this file created it.
drop function if exists public.grant_pass(uuid, text, text, int, int, text);
create or replace function public.grant_pass(
  p_user_id uuid, p_session_id text, p_pass text, p_days int,
  p_amount_cents int, p_currency text, p_payment_intent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current timestamptz;
  v_existing timestamptz;
  v_start timestamptz;
  v_end timestamptz;
begin
  select subscription_expires into v_current
    from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ends_at', null, 'error', 'no_user');
  end if;

  select ends_at into v_existing
    from public.pass_purchases where stripe_session_id = p_session_id;
  if found then
    return jsonb_build_object('ends_at', v_existing, 'duplicate', true);
  end if;

  v_start := greatest(now(), coalesce(v_current, now()));
  v_end := v_start + make_interval(days => p_days);

  insert into public.pass_purchases
    (user_id, stripe_session_id, pass, days, amount_cents, currency, starts_at, ends_at, stripe_payment_intent)
  values
    (p_user_id, p_session_id, p_pass, p_days, p_amount_cents, p_currency, v_start, v_end, p_payment_intent);

  update public.users
     set is_subscribed = true, subscription_expires = v_end
   where id = p_user_id;

  return jsonb_build_object('ends_at', v_end, 'duplicate', false);
end;
$$;

-- ── revoke_pass ─────────────────────────────────────────────────────
-- Called by the Stripe webhook when a pass's payment is fully refunded.
-- Marks the purchase refunded, then rebuilds the user's remaining passes in
-- purchase order so a pass stacked after the refunded one moves up to fill
-- the gap (each starts at its purchase time or when the one before it ends,
-- whichever is later, same as grant_pass). The account's end date and
-- is_subscribed follow. Idempotent: a second refund event changes nothing.
-- Rollover already earned is kept (it has no cash value and is capped).
create or replace function public.revoke_pass(p_payment_intent text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase record;
  v_legacy   timestamptz;
  v_prev_end timestamptz;
  v_start    timestamptz;
  v_end      timestamptz;
  r          record;
begin
  if p_payment_intent is null or p_payment_intent = '' then
    return jsonb_build_object('revoked', false, 'reason', 'no_payment_intent');
  end if;
  select id, user_id, pass, refunded_at into v_purchase
    from public.pass_purchases where stripe_payment_intent = p_payment_intent
   limit 1;
  if not found then
    return jsonb_build_object('revoked', false, 'reason', 'not_found');
  end if;
  if v_purchase.refunded_at is not null then
    return jsonb_build_object('revoked', false, 'reason', 'already_refunded', 'pass', v_purchase.pass);
  end if;

  select legacy_pass_until into v_legacy
    from public.users where id = v_purchase.user_id for update;

  update public.pass_purchases set refunded_at = now() where id = v_purchase.id;

  v_prev_end := v_legacy;
  for r in select id, days, created_at from public.pass_purchases
            where user_id = v_purchase.user_id and refunded_at is null
            order by created_at, id
  loop
    v_start := greatest(r.created_at, coalesce(v_prev_end, r.created_at));
    v_end := v_start + make_interval(days => r.days);
    update public.pass_purchases set starts_at = v_start, ends_at = v_end where id = r.id;
    v_prev_end := v_end;
  end loop;

  update public.users
     set subscription_expires = v_prev_end,
         is_subscribed = coalesce(v_prev_end > now(), false)
   where id = v_purchase.user_id;

  return jsonb_build_object('revoked', true, 'pass', v_purchase.pass, 'ends_at', v_prev_end);
end;
$$;

-- ── paid_on (internal) ──────────────────────────────────────────────
-- Did this user have a pass (or founder status) at any point on UTC day d?
create or replace function public.paid_on(p_user_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
     where u.id = p_user_id
       and (
         u.is_founder
         or (u.legacy_pass_until is not null
             and u.legacy_pass_until > (p_day::timestamp at time zone 'utc'))
         or exists (
           select 1 from public.pass_purchases pp
            where pp.user_id = p_user_id
              and pp.refunded_at is null
              and pp.starts_at < ((p_day + 1)::timestamp at time zone 'utc')
              and pp.ends_at   > (p_day::timestamp at time zone 'utc')
         )
       )
  );
$$;

-- ── settle_rollover (internal; the caller holds the user row lock) ──
-- Replays each day since the older marker, in order:
--   1. the 1st or 16th, not yet halved: rollover = ceil(rollover / 2)
--   2. a finished day (before today), not yet credited, paid that day, and
--      fewer than p_paid_limit daily photos used: rollover + 1
-- Halving is at the start of a day, credit at the end; that order matters.
-- First settle for anyone (both markers null): set the markers, no credit,
-- so nobody is back-credited for days before this shipped.
create or replace function public.settle_rollover(p_user_id uuid, p_paid_limit int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today  date := (now() at time zone 'utc')::date;
  v_roll   int;
  v_halved date;
  v_credit date;
  v_day    date;
  v_used   int;
begin
  select photo_rollover, rollover_halved_through, rollover_credit_through
    into v_roll, v_halved, v_credit
    from public.users where id = p_user_id;
  if not found then return; end if;

  if v_halved is null and v_credit is null then
    update public.users
       set rollover_halved_through = v_today,
           rollover_credit_through = v_today - 1
     where id = p_user_id;
    return;
  end if;
  v_halved := coalesce(v_halved, v_credit);
  v_credit := coalesce(v_credit, v_halved);

  v_day := least(v_halved, v_credit) + 1;
  while v_day <= v_today loop
    if extract(day from v_day) in (1, 16) and v_day > v_halved then
      v_roll := ceil(v_roll / 2.0)::int;
    end if;
    if v_day < v_today and v_day > v_credit and public.paid_on(p_user_id, v_day) then
      select coalesce(max(used_daily), 0) into v_used
        from public.photo_usage where user_id = p_user_id and day = v_day;
      if v_used < p_paid_limit then
        v_roll := v_roll + 1;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;

  update public.users
     set photo_rollover = v_roll,
         rollover_halved_through = greatest(v_halved, v_today),
         rollover_credit_through = greatest(v_credit, v_today - 1)
   where id = p_user_id;
end;
$$;

-- ── photo_quota_json (internal; already settled, lock held) ─────────
create or replace function public.photo_quota_json(p_user_id uuid, p_daily_limit int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_used  int;
  v_roll  int;
  v_next  date;
begin
  select coalesce(max(used_daily), 0) into v_used
    from public.photo_usage where user_id = p_user_id and day = v_today;
  select photo_rollover into v_roll from public.users where id = p_user_id;
  -- Next 1st or 16th strictly after today (today's halving already happened).
  v_next := case when extract(day from v_today) < 16
                 then date_trunc('month', v_today)::date + 15
                 else (date_trunc('month', v_today) + interval '1 month')::date end;
  return jsonb_build_object(
    'daily_limit', p_daily_limit,
    'used_today', v_used,
    'remaining_today', greatest(p_daily_limit - v_used, 0),
    'rollover', coalesce(v_roll, 0),
    -- Has a pass (or is a founder) right now.
    'earns_rollover', (select u.is_founder
                                  or (u.legacy_pass_until is not null and u.legacy_pass_until > now())
                                  or exists (select 1 from public.pass_purchases pp
                                              where pp.user_id = p_user_id
                                                and pp.refunded_at is null
                                                and pp.starts_at <= now() and pp.ends_at > now())
                             from public.users u where u.id = p_user_id),
    'next_halving', v_next,
    'resets_at', ((v_today + 1)::timestamp at time zone 'utc')
  );
end;
$$;

-- ── photo_quota ─────────────────────────────────────────────────────
create or replace function public.photo_quota(p_user_id uuid, p_daily_limit int, p_paid_limit int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then return null; end if;
  perform public.settle_rollover(p_user_id, p_paid_limit);
  return public.photo_quota_json(p_user_id, p_daily_limit);
end;
$$;

-- ── claim_photo (replaces claim_photo_read) ─────────────────────────
-- Today's allowance first, then rollover. Rollover is only drawn with
-- p_allow_rollover; without it the answer is needs_confirm and nothing is
-- used. Always returns the quota after the claim.
create or replace function public.claim_photo(
  p_user_id uuid, p_thread_id uuid, p_daily_limit int, p_paid_limit int,
  p_allow_rollover boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_used  int;
  v_roll  int;
  v_id    uuid;
begin
  perform 1 from public.users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('id', null, 'error', 'no_user');
  end if;
  perform public.settle_rollover(p_user_id, p_paid_limit);

  insert into public.photo_usage (user_id, day) values (p_user_id, v_today)
  on conflict (user_id, day) do nothing;
  select used_daily into v_used from public.photo_usage
   where user_id = p_user_id and day = v_today;
  select photo_rollover into v_roll from public.users where id = p_user_id;

  if v_used < p_daily_limit then
    update public.photo_usage set used_daily = used_daily + 1
     where user_id = p_user_id and day = v_today;
    insert into public.photo_reads (user_id, thread_id, source, usage_day)
    values (p_user_id, p_thread_id, 'daily', v_today)
    returning id into v_id;
  elsif v_roll > 0 then
    if not p_allow_rollover then
      return jsonb_build_object('id', null, 'needs_confirm', true,
                                'photos', public.photo_quota_json(p_user_id, p_daily_limit));
    end if;
    update public.users set photo_rollover = photo_rollover - 1 where id = p_user_id;
    update public.photo_usage set used_rollover = used_rollover + 1
     where user_id = p_user_id and day = v_today;
    insert into public.photo_reads (user_id, thread_id, source, usage_day)
    values (p_user_id, p_thread_id, 'rollover', v_today)
    returning id into v_id;
  end if;

  return jsonb_build_object('id', v_id, 'needs_confirm', false,
                            'photos', public.photo_quota_json(p_user_id, p_daily_limit));
end;
$$;

-- ── release_photo ───────────────────────────────────────────────────
-- Gives back a read that never finished (the model call failed). Only a row
-- still pending, and the photo goes back to the pile it came from.
create or replace function public.release_photo(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select id, user_id, source, usage_day into r
    from public.photo_reads where id = p_id and status = 'pending';
  if not found then return; end if;
  perform 1 from public.users where id = r.user_id for update;

  if r.source = 'daily' then
    update public.photo_usage set used_daily = greatest(used_daily - 1, 0)
     where user_id = r.user_id and day = r.usage_day;
  elsif r.source = 'rollover' then
    update public.users set photo_rollover = photo_rollover + 1 where id = r.user_id;
    update public.photo_usage set used_rollover = greatest(used_rollover - 1, 0)
     where user_id = r.user_id and day = r.usage_day;
  end if;
  delete from public.photo_reads where id = p_id and status = 'pending';
end;
$$;

-- Service role only, every function. PUBLIC is in the list on purpose:
-- Postgres grants EXECUTE on new functions to PUBLIC by default.
revoke all on function public.grant_pass(uuid, text, text, int, int, text, text) from public, anon, authenticated;
grant execute on function public.grant_pass(uuid, text, text, int, int, text, text) to service_role;
revoke all on function public.revoke_pass(text) from public, anon, authenticated;
grant execute on function public.revoke_pass(text) to service_role;
revoke all on function public.paid_on(uuid, date) from public, anon, authenticated;
grant execute on function public.paid_on(uuid, date) to service_role;
revoke all on function public.settle_rollover(uuid, int) from public, anon, authenticated;
grant execute on function public.settle_rollover(uuid, int) to service_role;
revoke all on function public.photo_quota_json(uuid, int) from public, anon, authenticated;
grant execute on function public.photo_quota_json(uuid, int) to service_role;
revoke all on function public.photo_quota(uuid, int, int) from public, anon, authenticated;
grant execute on function public.photo_quota(uuid, int, int) to service_role;
revoke all on function public.claim_photo(uuid, uuid, int, int, boolean) from public, anon, authenticated;
grant execute on function public.claim_photo(uuid, uuid, int, int, boolean) to service_role;
revoke all on function public.release_photo(uuid) from public, anon, authenticated;
grant execute on function public.release_photo(uuid) to service_role;

commit;
