-- ============================================================
-- StoneHead AI — Migration 006: Founding members ("OG Seshers")
-- A permanent, manually-granted status for the earliest testers.
-- Founder status is a hard override: it grants unlimited access
-- independently of is_subscribed / subscription_expires, and it
-- is never revoked by day-rollover, subscription lapse, or a
-- future change to free-tier rules.
-- Hard cap enforced at grant time (scripts/grant-founder.mjs),
-- not by the schema.
-- ============================================================

alter table users
  add column is_founder        boolean not null default false,
  add column founder_number    integer default null,   -- 1..N, display order ("OG Sesher #3")
  add column founder_granted_at timestamptz default null;

-- founder_number is unique when present, so no two accounts claim the same badge.
-- (Partial unique index: nulls are unconstrained, so non-founders don't collide.)
create unique index idx_users_founder_number
  on users(founder_number)
  where founder_number is not null;
