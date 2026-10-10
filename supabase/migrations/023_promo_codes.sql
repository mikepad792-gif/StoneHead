-- 023_promo_codes.sql
-- Promo codes (v2.1.4). First codes: STONEHEAD14 (sticker run) and
-- STONERSDAILY14 (Stoner's Daily), 14 free days each. Redeemed through api/promo-redeem.js with the service key.
--
-- A promo grant goes through grant_pass (migration 019), the same function
-- the Stripe webhook calls, and is recorded in pass_purchases as pass
-- 'promo'. That keeps free days on exactly the paid-days path: they stack on
-- an active pass, revoke_pass keeps them when it rebuilds the chain after a
-- refund of some OTHER pass, and paid_on counts them for rollover credit.
--
-- RLS on, no policies, nothing granted to anon/authenticated (same lockdown
-- as 021). Safe to run again.

create table if not exists public.promo_codes (
  code        text primary key check (code = upper(code)),
  days        int  not null check (days between 1 and 90),
  max_uses    int  not null check (max_uses > 0),
  uses        int  not null default 0,
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now()
);

-- One use per account, enforced by the database. Deleted with the account;
-- promo_codes.uses keeps counting it, so the cap still holds.
create table if not exists public.promo_redemptions (
  id             bigint generated always as identity primary key,
  code           text not null references public.promo_codes(code),
  user_id        uuid not null references public.users(id) on delete cascade,
  days_granted   int  not null,
  expires_before timestamptz,          -- subscription_expires before this grant
  expires_after  timestamptz not null,
  redeemed_at    timestamptz not null default now(),
  unique (code, user_id)
);

-- Failed tries only, for the 5-an-hour limit in api/promo-redeem.js.
create table if not exists public.promo_attempts (
  user_id    uuid not null references public.users(id) on delete cascade,
  tried_at   timestamptz not null default now()
);
create index if not exists idx_promo_attempts_user_tried on public.promo_attempts (user_id, tried_at);

alter table public.promo_codes       enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.promo_attempts    enable row level security;
revoke all on public.promo_codes, public.promo_redemptions, public.promo_attempts
  from public, anon, authenticated;

-- pass_purchases gains a 'promo' kind (019 allowed only the two Stripe passes).
alter table public.pass_purchases drop constraint if exists pass_purchases_pass_check;
alter table public.pass_purchases
  add constraint pass_purchases_pass_check check (pass in ('7day', '30day', 'promo'));

-- Redeem one code for one account, atomically. Returns
-- {"status": ok | not_found | not_started | expired | used_up | founder | already_used,
--  "days": n, "subscription_expires": ts}. Nothing changes unless status is ok.
create or replace function public.redeem_promo(p_user uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code   text := upper(trim(coalesce(p_code, '')));
  c        record;
  v_founder boolean;
  v_before timestamptz;
  v_grant  jsonb;
  v_after  timestamptz;
begin
  -- The row lock serializes redeems of one code, so two can't both slip
  -- past the cap.
  select * into c from public.promo_codes where code = v_code for update;
  if not found or not c.active then
    return jsonb_build_object('status', 'not_found');
  end if;
  if c.starts_at > now() then
    return jsonb_build_object('status', 'not_started');
  end if;
  if c.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if c.uses >= c.max_uses then
    return jsonb_build_object('status', 'used_up');
  end if;

  select is_founder, subscription_expires into v_founder, v_before
    from public.users where id = p_user for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_founder then
    return jsonb_build_object('status', 'founder');   -- the code is not used up
  end if;
  if exists (select 1 from public.promo_redemptions where code = v_code and user_id = p_user) then
    return jsonb_build_object('status', 'already_used');
  end if;

  begin
    v_grant := public.grant_pass(p_user, 'promo:' || v_code || ':' || p_user::text, 'promo',
                                 c.days, 0, null, null);
    v_after := (v_grant->>'ends_at')::timestamptz;
    insert into public.promo_redemptions (code, user_id, days_granted, expires_before, expires_after)
    values (v_code, p_user, c.days, v_before, v_after);
  exception when unique_violation then
    -- The grant above is rolled back with this block.
    return jsonb_build_object('status', 'already_used');
  end;

  update public.promo_codes set uses = uses + 1 where code = v_code;
  return jsonb_build_object('status', 'ok', 'days', c.days, 'subscription_expires', v_after);
end;
$$;

revoke all on function public.redeem_promo(uuid, text) from public, anon, authenticated;
grant execute on function public.redeem_promo(uuid, text) to service_role;

-- The first codes. Re-running this file leaves existing rows alone.
insert into public.promo_codes (code, days, max_uses, expires_at, note)
values ('STONEHEAD14', 14, 100, '2027-04-30 23:59:59-07', 'Sticker run 1, Zugmonster, Oct 2026'),
       ('STONERSDAILY14', 14, 100, '2027-04-30 23:59:59-07', 'Stoner''s Daily, Oct 2026')
on conflict (code) do nothing;

-- Shut a code off early:  update public.promo_codes set active = false where code = '...';
-- Add a code:             insert another row; no deploy needed.
