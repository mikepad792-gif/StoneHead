-- ============================================================
-- StoneHead AI — Migration 007: Extensible badge system
-- Registry + join: `badges` is one row per KIND of badge,
-- `user_badges` is one row per badge a user holds. Adding a new
-- badge later is a data insert, not a migration.
--
-- SEPARATE from the founder system by design. Founder
-- (users.is_founder / founder_number) is the only badge that
-- touches the paywall and stays on its own columns; this system
-- is structurally unable to reach the usage gate, so a bug in
-- badge-granting can never leak free access.
--
-- Additive only: no existing table, column, or policy is touched.
-- Safe to run on the live database at any time before the code
-- deploys (nothing deployed reads these tables until then).
-- ============================================================

-- One row per KIND of badge
create table public.badges (
  key        text primary key,               -- 'first_artist', 'og_sesher', ...
  label      text not null,                  -- 'First Artist'
  color      text not null,                  -- hex, e.g. '#c96a3a'
  cap        int,                            -- null = uncapped; 1 = single scarce slot
  perks      jsonb not null default '{}'::jsonb,  -- DORMANT. {} for cosmetic badges.
  created_at timestamptz not null default now()
);

-- One row per badge a user holds
create table public.user_badges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  badge_key  text not null references public.badges(key),
  number     int,                            -- ordinal within that badge type (1 = first)
  granted_at timestamptz not null default now(),
  unique (user_id, badge_key),               -- a user holds each badge at most once
  unique (badge_key, number)                 -- no duplicate "#1" for a given badge
);

create index user_badges_user_id_idx on public.user_badges (user_id);

-- ── RLS: default-deny for everyone except service role ──────
-- Public read (needed to render badge strips); NO insert/update/
-- delete policies for anon or authenticated, so all writes from
-- client keys are denied. Granting happens only through the
-- service-role script (scripts/grant-badge.mjs), which bypasses RLS.

alter table public.badges enable row level security;
alter table public.user_badges enable row level security;

create policy "badges are readable" on public.badges
  for select using (true);

create policy "user_badges are readable" on public.user_badges
  for select using (true);

-- ── Seed: the first badge ────────────────────────────────────
-- first_artist, cap 1 (scarce — exactly one holder until the rule
-- changes), no perks. Terracotta so it reads as distinct from
-- founder amber (#deaa3c) in the strip.
-- Future badges are just more inserts like this one.

insert into public.badges (key, label, color, cap, perks) values
  ('first_artist', 'First Artist', '#c96a3a', 1, '{}'::jsonb)
on conflict (key) do nothing;
