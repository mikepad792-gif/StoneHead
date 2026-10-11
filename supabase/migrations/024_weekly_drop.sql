-- 024_weekly_drop.sql
-- The Weekly Moai Drop (v2.2.0): Discord linking, active days, and the
-- weekly draw. Everything here is reached only through Netlify functions with
-- the service key. The bot never touches the database: it calls the
-- bot-* endpoints with the shared secret.
--
-- RLS on, no policies, nothing granted to anon/authenticated (same lockdown
-- as 021). Safe to run again.

-- ── Discord linking ─────────────────────────────────────────────────
-- discord_id is Discord's permanent user id (a snowflake), never the
-- username. One Discord per account and one account per Discord.
alter table public.users
  add column if not exists discord_id        text unique,
  add column if not exists discord_username  text,
  add column if not exists discord_linked_at timestamptz;

-- One row per /link (or per Enter tap from someone not linked yet). The token
-- goes in the URL; the 6-digit short_code is the typed fallback. A new /link
-- expires the old ones instead of deleting them, so the rows still count for
-- the 3-per-10-minutes limit; rows older than a day are cleared on the next
-- /link and on each draw.
create table if not exists public.discord_link_requests (
  token            text primary key,
  short_code       text not null unique check (short_code ~ '^[0-9]{6}$'),
  discord_id       text not null,
  discord_username text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  used_at          timestamptz
);
create index if not exists idx_discord_link_requests_discord on public.discord_link_requests (discord_id, created_at);

-- Failed link tries, for the 5-an-hour limit in api/discord-link.js.
create table if not exists public.discord_link_attempts (
  user_id  uuid not null references public.users(id) on delete cascade,
  tried_at timestamptz not null default now()
);
create index if not exists idx_discord_link_attempts_user_tried on public.discord_link_attempts (user_id, tried_at);

-- ── Active days ─────────────────────────────────────────────────────
-- Which Pacific dates an account sent StoneHead a message. Dates only, no
-- content. Separate from user_activity_days (008), which is UTC and counts
-- messages for the dashboard.
create table if not exists public.user_active_days (
  user_id uuid not null references public.users(id) on delete cascade,
  day     date not null,
  primary key (user_id, day)
);

-- ── Rounds and entries ──────────────────────────────────────────────
create table if not exists public.giveaway_rounds (
  id                 bigint generated always as identity primary key,
  guild_id           text not null,
  channel_id         text not null,
  message_id         text,
  week_start         date not null,                -- Monday, Pacific
  draw_at            timestamptz not null,         -- that Sunday, 9 PM Pacific
  prize              text not null check (length(prize) between 1 and 200),
  prize_pass_days    int  not null default 30 check (prize_pass_days between 0 and 365),
  entrant_bonus_days int  not null default 0  check (entrant_bonus_days between 0 and 30),
  status             text not null default 'open' check (status in ('open', 'drawn', 'cancelled')),
  winner_user_id     uuid references public.users(id) on delete set null,
  winner_needs_substitute boolean not null default false,  -- a founder won: no pass, Mike picks a prize
  total_people       int,
  total_entries      int,
  entries            jsonb,                        -- [{user_id, entries}] for audit; never shown publicly
  last_nudge_on      date,                         -- Pacific date of the last "finish linking" nudge
  created_at         timestamptz not null default now(),
  drawn_at           timestamptz
);
-- One open round per server at a time.
create unique index if not exists idx_giveaway_rounds_one_open
  on public.giveaway_rounds (guild_id) where status = 'open';

create table if not exists public.giveaway_entries (
  round_id         bigint not null references public.giveaway_rounds(id) on delete cascade,
  discord_id       text not null,
  discord_username text,                           -- display name for the spin, from the last tap
  entered_at       timestamptz not null default now(),
  left_at          timestamptz,                    -- "Leave this week"; null = in
  primary key (round_id, discord_id)
);

alter table public.discord_link_requests enable row level security;
alter table public.discord_link_attempts enable row level security;
alter table public.user_active_days      enable row level security;
alter table public.giveaway_rounds       enable row level security;
alter table public.giveaway_entries      enable row level security;
revoke all on public.discord_link_requests, public.discord_link_attempts, public.user_active_days,
              public.giveaway_rounds, public.giveaway_entries
  from public, anon, authenticated;

-- pass_purchases gains a 'giveaway' kind, so prize and bonus days ride the
-- same grant_pass path as paid and promo days.
alter table public.pass_purchases drop constraint if exists pass_purchases_pass_check;
alter table public.pass_purchases
  add constraint pass_purchases_pass_check check (pass in ('7day', '30day', 'promo', 'giveaway'));

-- ── link_discord ────────────────────────────────────────────────────
-- Attaches the Discord behind a live link request to p_user, by token or by
-- short code. If that Discord was linked to another account, it moves: the
-- person who ran /link owns that Discord. Returns
-- {"status": ok | bad_link, "discord_username", "entered_round"}.
create or replace function public.link_discord(p_user uuid, p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r       public.discord_link_requests%rowtype;
  v_found boolean := false;
begin
  if coalesce(p_token, '') <> '' then
    select * into r from public.discord_link_requests where token = p_token for update;
    v_found := found;
  elsif coalesce(p_code, '') <> '' then
    select * into r from public.discord_link_requests where short_code = p_code for update;
    v_found := found;
  end if;
  if not v_found or r.used_at is not null or r.expires_at <= now() then
    return jsonb_build_object('status', 'bad_link');
  end if;

  perform 1 from public.users where id = p_user for update;
  if not found then
    return jsonb_build_object('status', 'bad_link');
  end if;

  update public.users
     set discord_id = null, discord_username = null, discord_linked_at = null
   where discord_id = r.discord_id and id <> p_user;
  update public.users
     set discord_id = r.discord_id, discord_username = r.discord_username, discord_linked_at = now()
   where id = p_user;
  update public.discord_link_requests set used_at = now() where token = r.token;

  return jsonb_build_object(
    'status', 'ok',
    'discord_username', r.discord_username,
    'entered_round', exists (
      select 1 from public.giveaway_entries e
        join public.giveaway_rounds g on g.id = e.round_id
       where e.discord_id = r.discord_id and e.left_at is null
         and g.status = 'open' and g.draw_at > now()));
end;
$$;

-- ── create_giveaway_round ───────────────────────────────────────────
-- This week's round: week_start is Monday (Pacific) and the draw is that
-- Sunday at 9 PM Pacific. Started after Sunday's 9 PM, it's next week's.
create or replace function public.create_giveaway_round(
  p_guild text, p_channel text, p_prize text, p_pass_days int, p_bonus_days int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today  date := (now() at time zone 'America/Los_Angeles')::date;
  v_monday date;
  v_draw   timestamptz;
  v_id     bigint;
begin
  v_monday := v_today - (extract(isodow from v_today)::int - 1);
  v_draw := ((v_monday + 6) + time '21:00') at time zone 'America/Los_Angeles';
  if v_draw <= now() then
    v_monday := v_monday + 7;
    v_draw := ((v_monday + 6) + time '21:00') at time zone 'America/Los_Angeles';
  end if;
  begin
    insert into public.giveaway_rounds (guild_id, channel_id, prize, prize_pass_days, entrant_bonus_days, week_start, draw_at)
    values (p_guild, p_channel, p_prize, p_pass_days, p_bonus_days, v_monday, v_draw)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('status', 'already_open');
  end;
  return jsonb_build_object('status', 'ok', 'round_id', v_id, 'week_start', v_monday, 'draw_at', v_draw);
end;
$$;

-- ── giveaway_pick ───────────────────────────────────────────────────
-- Weighted pick: p_entries is [{user_id, entries}], p_r a random number from
-- crypto.randomInt in the function. Target = p_r mod total, then walk the
-- running sum. The total is at most 8 per person, so the modulo bias
-- against a 48-bit p_r is nil.
create or replace function public.giveaway_pick(p_entries jsonb, p_r bigint)
returns uuid
language plpgsql
immutable
as $$
declare
  v_total  bigint := 0;
  v_target bigint;
  v_run    bigint := 0;
  e        jsonb;
begin
  select coalesce(sum((x->>'entries')::int), 0) into v_total from jsonb_array_elements(p_entries) x;
  if v_total <= 0 then return null; end if;
  v_target := abs(p_r) % v_total;
  for e in select x from jsonb_array_elements(p_entries) x loop
    v_run := v_run + (e->>'entries')::int;
    if v_target < v_run then return (e->>'user_id')::uuid; end if;
  end loop;
  return null;
end;
$$;

-- ── draw_giveaway ───────────────────────────────────────────────────
-- One transaction: count entries, pick, grant, save. A round draws once.
-- Counted: tapped Enter and didn't leave, linked, not internal. Entries =
-- 1 + Pacific days with a message from Monday through the draw day, days
-- capped at 7.
create or replace function public.draw_giveaway(p_round bigint, p_r bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g          public.giveaway_rounds%rowtype;
  v_upto     date;
  v_entries  jsonb;
  v_total    int;
  v_people   int;
  v_winner   uuid;
  v_founder  boolean := false;
  v_wdiscord text;
  v_wname    text;
  v_names    jsonb;
  e          jsonb;
begin
  select * into g from public.giveaway_rounds where id = p_round for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if g.status <> 'open' then
    return jsonb_build_object('status', 'not_open', 'round_status', g.status);
  end if;

  v_upto := least((now() at time zone 'America/Los_Angeles')::date, g.week_start + 6);

  with counted as (
    select u.id as user_id,
           1 + least(7, (select count(*) from public.user_active_days d
                          where d.user_id = u.id and d.day between g.week_start and v_upto))::int as n
      from public.giveaway_entries ge
      join public.users u on u.discord_id = ge.discord_id
     where ge.round_id = p_round and ge.left_at is null and not u.is_internal
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'entries', n) order by user_id), '[]'::jsonb),
         coalesce(sum(n), 0), count(*)
    into v_entries, v_total, v_people
    from counted;

  v_winner := public.giveaway_pick(v_entries, p_r);

  if v_winner is not null then
    select is_founder, discord_id into v_founder, v_wdiscord from public.users where id = v_winner;
    select coalesce(ge.discord_username, u.discord_username) into v_wname
      from public.users u
      left join public.giveaway_entries ge on ge.round_id = p_round and ge.discord_id = u.discord_id
     where u.id = v_winner;
    if not v_founder and g.prize_pass_days > 0 then
      perform public.grant_pass(v_winner, 'giveaway:' || p_round || ':win', 'giveaway',
                                g.prize_pass_days, 0, null, null);
    end if;
  end if;

  -- Bonus week: every counted entrant (founders already have everything).
  if g.entrant_bonus_days > 0 then
    for e in select x from jsonb_array_elements(v_entries) x loop
      if not (select is_founder from public.users where id = (e->>'user_id')::uuid) then
        perform public.grant_pass((e->>'user_id')::uuid,
                                  'giveaway:' || p_round || ':bonus:' || (e->>'user_id'),
                                  'giveaway', g.entrant_bonus_days, 0, null, null);
      end if;
    end loop;
  end if;

  -- Up to 12 counted names for the spin, shuffled.
  select coalesce(jsonb_agg(name), '[]'::jsonb) into v_names from (
    select coalesce(ge.discord_username, u.discord_username, 'someone') as name
      from jsonb_array_elements(v_entries) x
      join public.users u on u.id = (x->>'user_id')::uuid
      left join public.giveaway_entries ge on ge.round_id = p_round and ge.discord_id = u.discord_id
     order by random() limit 12) s;

  update public.giveaway_rounds
     set status = 'drawn', drawn_at = now(), winner_user_id = v_winner,
         winner_needs_substitute = coalesce(v_founder, false),
         total_people = v_people, total_entries = v_total, entries = v_entries
   where id = p_round;

  -- Housekeeping while we're here.
  delete from public.user_active_days where day < (now() at time zone 'America/Los_Angeles')::date - 120;
  delete from public.discord_link_requests where created_at < now() - interval '1 day';

  return jsonb_build_object(
    'status', case when v_winner is null then 'no_entries' else 'ok' end,
    'winner_discord_id', v_wdiscord,
    'winner_name', v_wname,
    'winner_is_founder', coalesce(v_founder, false),
    'total_people', v_people,
    'total_entries', v_total,
    'spin_names', v_names,
    'prize', g.prize,
    'channel_id', g.channel_id,
    'message_id', g.message_id);
end;
$$;

-- ── claim_giveaway_nudges ───────────────────────────────────────────
-- Called by the bot every few minutes. From 6 PM Pacific, each open round is
-- claimed once a day and reports how many entries are still unlinked.
create or replace function public.claim_giveaway_nudges()
returns table (round_id bigint, channel_id text, unlinked int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp := now() at time zone 'America/Los_Angeles';
begin
  if v_local::time < time '18:00' then return; end if;
  return query
  with claimed as (
    update public.giveaway_rounds g
       set last_nudge_on = v_local::date
     where g.status = 'open' and g.draw_at > now()
       and g.last_nudge_on is distinct from v_local::date
    returning g.id, g.channel_id
  )
  select c.id, c.channel_id,
         (select count(*)::int from public.giveaway_entries ge
           where ge.round_id = c.id and ge.left_at is null
             and not exists (select 1 from public.users u where u.discord_id = ge.discord_id))
    from claimed c;
end;
$$;

revoke all on function public.link_discord(uuid, text, text) from public, anon, authenticated;
grant execute on function public.link_discord(uuid, text, text) to service_role;
revoke all on function public.create_giveaway_round(text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.create_giveaway_round(text, text, text, int, int) to service_role;
revoke all on function public.giveaway_pick(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.giveaway_pick(jsonb, bigint) to service_role;
revoke all on function public.draw_giveaway(bigint, bigint) from public, anon, authenticated;
grant execute on function public.draw_giveaway(bigint, bigint) to service_role;
revoke all on function public.claim_giveaway_nudges() from public, anon, authenticated;
grant execute on function public.claim_giveaway_nudges() to service_role;
