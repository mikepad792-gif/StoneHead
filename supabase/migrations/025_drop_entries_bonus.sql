-- 025_drop_entries_bonus.sql
-- Moai Drop follow-ups (v2.2.1). Run after 024. Safe to run again.
--
-- 1. giveaway_round_entries: the ONE place a round's entries are counted.
--    draw_giveaway picks from it and /drop-entries lists it, so the admin
--    list always matches the draw pool.
-- 2. Bonus days move from the draw to the moment someone has both tapped
--    Enter and linked (whichever comes second). Leaving afterwards keeps
--    them. The draw still sweeps up anyone missed, as a safety net. Once per round per Discord account AND per StoneHead account, so
--    moving a Discord to a second account, or a second Discord to the same
--    account, doesn't pay twice.

-- ── giveaway_round_entries ──────────────────────────────────────────
-- Counted: tapped Enter and didn't leave, Discord linked, not internal.
-- Entries = 1 for entering + Pacific days with a message from Monday
-- through today (or Sunday, once the week is over), days capped at 7.
create or replace function public.giveaway_round_entries(p_round bigint)
returns table (user_id uuid, discord_id text, discord_name text, username text,
               is_founder boolean, link_entry int, days int, total int)
language sql
stable
security definer
set search_path = public
as $$
  with g as (
    select id, week_start,
           least((now() at time zone 'America/Los_Angeles')::date, week_start + 6) as upto
      from public.giveaway_rounds where id = p_round
  )
  select u.id, ge.discord_id, coalesce(ge.discord_username, u.discord_username), u.username,
         u.is_founder, 1, d.days, 1 + d.days
    from g
    join public.giveaway_entries ge on ge.round_id = g.id and ge.left_at is null
    join public.users u on u.discord_id = ge.discord_id and not u.is_internal
    cross join lateral (
      select least(7, count(*))::int as days from public.user_active_days a
       where a.user_id = u.id and a.day between g.week_start and g.upto
    ) d
$$;

-- ── grant_entry_bonus ───────────────────────────────────────────────
-- Called when someone taps Enter while linked, and when someone links.
-- Grants each open bonus round they've entered (left or not) that hasn't
-- paid them yet. Founders already have everything; internal accounts are
-- staff. Returns {"days": total granted by this call}.
create or replace function public.grant_entry_bonus(p_discord_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid;
  v_skip  boolean;
  r       record;
  v_days  int := 0;
begin
  select id, (is_founder or is_internal) into v_user, v_skip
    from public.users where discord_id = p_discord_id for update;
  if not found or v_skip then
    return jsonb_build_object('days', 0);
  end if;

  for r in
    select g.id, g.entrant_bonus_days
      from public.giveaway_rounds g
      join public.giveaway_entries ge on ge.round_id = g.id and ge.discord_id = p_discord_id
     where g.status = 'open' and g.entrant_bonus_days > 0
  loop
    if exists (select 1 from public.pass_purchases
                where stripe_session_id = 'giveaway:' || r.id || ':bonus:d:' || p_discord_id
                   or (user_id = v_user and stripe_session_id like 'giveaway:' || r.id || ':bonus:%')) then
      continue;
    end if;
    perform public.grant_pass(v_user, 'giveaway:' || r.id || ':bonus:d:' || p_discord_id,
                              'giveaway', r.entrant_bonus_days, 0, null, null);
    v_days := v_days + r.entrant_bonus_days;
  end loop;

  return jsonb_build_object('days', v_days);
end;
$$;

-- ── link_discord: same as 024, plus the bonus on linking ────────────
create or replace function public.link_discord(p_user uuid, p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r       public.discord_link_requests%rowtype;
  v_found boolean := false;
  v_bonus jsonb;
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

  v_bonus := public.grant_entry_bonus(r.discord_id);

  return jsonb_build_object(
    'status', 'ok',
    'discord_username', r.discord_username,
    'bonus_days', coalesce((v_bonus->>'days')::int, 0),
    'entered_round', exists (
      select 1 from public.giveaway_entries e
        join public.giveaway_rounds g on g.id = e.round_id
       where e.discord_id = r.discord_id and e.left_at is null
         and g.status = 'open' and g.draw_at > now()));
end;
$$;

-- ── draw_giveaway: counts through giveaway_round_entries, no bonus ──
create or replace function public.draw_giveaway(p_round bigint, p_r bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  g          public.giveaway_rounds%rowtype;
  v_entries  jsonb;
  v_total    int;
  v_people   int;
  v_winner   uuid;
  v_founder  boolean := false;
  v_wdiscord text;
  v_wname    text;
  v_names    jsonb;
begin
  select * into g from public.giveaway_rounds where id = p_round for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if g.status <> 'open' then
    return jsonb_build_object('status', 'not_open', 'round_status', g.status);
  end if;

  -- Safety net for the bonus: anyone entered (left or not) and linked who
  -- somehow wasn't paid yet gets it now. grant_entry_bonus never pays twice.
  perform public.grant_entry_bonus(x.discord_id)
     from (select distinct ge.discord_id from public.giveaway_entries ge
             join public.users u on u.discord_id = ge.discord_id
            where ge.round_id = p_round and g.entrant_bonus_days > 0) x;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', e.user_id, 'entries', e.total) order by e.user_id), '[]'::jsonb),
         coalesce(sum(e.total), 0), count(*)
    into v_entries, v_total, v_people
    from public.giveaway_round_entries(p_round) e;

  v_winner := public.giveaway_pick(v_entries, p_r);

  if v_winner is not null then
    select e.is_founder, e.discord_id, e.discord_name into v_founder, v_wdiscord, v_wname
      from public.giveaway_round_entries(p_round) e where e.user_id = v_winner;
    if not v_founder and g.prize_pass_days > 0 then
      perform public.grant_pass(v_winner, 'giveaway:' || p_round || ':win', 'giveaway',
                                g.prize_pass_days, 0, null, null);
    end if;
  end if;

  select coalesce(jsonb_agg(name), '[]'::jsonb) into v_names from (
    select coalesce(e.discord_name, 'someone') as name
      from public.giveaway_round_entries(p_round) e
     order by random() limit 12) s;

  update public.giveaway_rounds
     set status = 'drawn', drawn_at = now(), winner_user_id = v_winner,
         winner_needs_substitute = coalesce(v_founder, false),
         total_people = v_people, total_entries = v_total, entries = v_entries
   where id = p_round;

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

revoke all on function public.giveaway_round_entries(bigint) from public, anon, authenticated;
grant execute on function public.giveaway_round_entries(bigint) to service_role;
revoke all on function public.grant_entry_bonus(text) from public, anon, authenticated;
grant execute on function public.grant_entry_bonus(text) to service_role;
revoke all on function public.link_discord(uuid, text, text) from public, anon, authenticated;
grant execute on function public.link_discord(uuid, text, text) to service_role;
revoke all on function public.draw_giveaway(bigint, bigint) from public, anon, authenticated;
grant execute on function public.draw_giveaway(bigint, bigint) to service_role;

-- Anyone already entered and linked in an open bonus round gets it now.
select public.grant_entry_bonus(x.discord_id)
  from (select distinct ge.discord_id
          from public.giveaway_entries ge
          join public.giveaway_rounds g on g.id = ge.round_id
          join public.users u on u.discord_id = ge.discord_id
         where g.status = 'open' and g.entrant_bonus_days > 0) x;
