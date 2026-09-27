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
