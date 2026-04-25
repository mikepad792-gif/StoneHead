-- ============================================================
-- StoneHead AI — Thread 1: Database Schema
-- All table and column names match MASTER_TERMS.md exactly.
-- snake_case everywhere. No aliases. No deviations.
-- ============================================================

-- Enable uuid generation
create extension if not exists "uuid-ossp";

-- =========================
-- 1. users
-- =========================
create table users (
  id                    uuid primary key default uuid_generate_v4(),
  email                 text not null unique,
  username              text not null unique,
  password_hash         text not null,
  is_subscribed         boolean not null default false,
  subscription_expires  timestamptz default null,
  age_verified          boolean not null default false,
  daily_message_count   integer not null default 0,
  last_message_date     date default null,
  created_at            timestamptz not null default now()
);

-- =========================
-- 2. threads
-- =========================
create table threads (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references users(id) on delete cascade,
  title                 text not null default 'New Thread',
  tab                   text not null check (tab in ('vibe', 'plant')),
  data_opt_in           boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index idx_threads_user_id on threads(user_id);

-- =========================
-- 3. messages
-- =========================
create table messages (
  id                    uuid primary key default uuid_generate_v4(),
  thread_id             uuid not null references threads(id) on delete cascade,
  role                  text not null check (role in ('user', 'assistant')),
  content               text not null,
  content_augmented     text default null,
  tokens_in             integer not null default 0,
  tokens_out            integer not null default 0,
  created_at            timestamptz not null default now()
);

create index idx_messages_thread_id on messages(thread_id);

-- =========================
-- 4. liked_strains
-- =========================
create table liked_strains (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references users(id) on delete cascade,
  strain_name           text not null,
  strain_type           text not null check (strain_type in ('indica', 'sativa', 'hybrid')),
  notes                 text default null,
  added_at              timestamptz not null default now()
);

create index idx_liked_strains_user_id on liked_strains(user_id);

-- =========================
-- 5. payment_codes
-- =========================
create table payment_codes (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid not null references users(id) on delete cascade,
  code                  text not null unique,
  status                text not null default 'pending' check (status in ('pending', 'used', 'expired')),
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null
);

create index idx_payment_codes_user_id on payment_codes(user_id);
create index idx_payment_codes_code on payment_codes(code);

-- =========================
-- Row Level Security
-- =========================

alter table users enable row level security;
alter table threads enable row level security;
alter table messages enable row level security;
alter table liked_strains enable row level security;
alter table payment_codes enable row level security;

-- Users can read/update their own row
create policy "users_select_own" on users
  for select using (id = auth.uid());
create policy "users_update_own" on users
  for update using (id = auth.uid());

-- Threads: users see only their own
create policy "threads_select_own" on threads
  for select using (user_id = auth.uid());
create policy "threads_insert_own" on threads
  for insert with check (user_id = auth.uid());
create policy "threads_update_own" on threads
  for update using (user_id = auth.uid());

-- Messages: users see messages in their own threads
create policy "messages_select_own" on messages
  for select using (
    thread_id in (select id from threads where user_id = auth.uid())
  );
create policy "messages_insert_own" on messages
  for insert with check (
    thread_id in (select id from threads where user_id = auth.uid())
  );

-- Liked strains: users manage their own
create policy "liked_strains_select_own" on liked_strains
  for select using (user_id = auth.uid());
create policy "liked_strains_insert_own" on liked_strains
  for insert with check (user_id = auth.uid());
create policy "liked_strains_delete_own" on liked_strains
  for delete using (user_id = auth.uid());

-- Payment codes: users see their own
create policy "payment_codes_select_own" on payment_codes
  for select using (user_id = auth.uid());
create policy "payment_codes_insert_own" on payment_codes
  for insert with check (user_id = auth.uid());
