-- 020_support_requests.sql
-- The support form in the profile (api/support.js).
--
-- Every report is saved here first, then emailed to support@ through Resend.
-- Saving first means a report is never lost to an email outage: `emailed`
-- stays false and it can be read here instead.
--
-- Deleted with the account (cascade), like everything else the policy lists.
-- Safe to run again.

create table if not exists public.support_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  email        text not null check (char_length(email) <= 254),
  message      text not null check (char_length(message) between 1 and 2000),
  app_version  text,
  emailed      boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists idx_support_requests_user_created
  on public.support_requests (user_id, created_at desc);

-- Reached only through the service-role client in the function.
alter table public.support_requests enable row level security;
revoke all on public.support_requests from public, anon, authenticated;
