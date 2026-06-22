-- ============================================================
-- StoneHead AI — Migration 003: session_memories
-- Frame-tagged, compressed thread summaries (Phase 2 memory layer).
-- snake_case throughout, matching MASTER_TERMS.md conventions.
-- frame_tag uses the renamed taxonomy: 'grounding' (not 'reorientation').
-- ============================================================

create table session_memories (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references users(id) on delete cascade,
  thread_id      uuid not null references threads(id) on delete cascade,
  summary        text not null,
  frame_tag      text not null check (frame_tag in (
                   'breakthrough', 'challenge', 'friction',
                   'trust-building', 'routine', 'grounding'
                 )),
  tab            text not null check (tab in ('vibe', 'plant')),
  message_count  integer not null default 0,
  created_at     timestamptz not null default now()
);

create index idx_session_memories_user_id on session_memories(user_id);
create index idx_session_memories_thread_id on session_memories(thread_id);

-- =========================
-- Row Level Security
-- =========================
alter table session_memories enable row level security;

-- Users manage only their own session memories. Server writes use the
-- service-role client (bypasses RLS); these policies cover any client-side
-- read/clear (e.g. the optional "what Stone Head remembers" view).
create policy "session_memories_select_own" on session_memories
  for select using (user_id = auth.uid());
create policy "session_memories_insert_own" on session_memories
  for insert with check (user_id = auth.uid());
create policy "session_memories_delete_own" on session_memories
  for delete using (user_id = auth.uid());

-- ============================================================
-- Backfill note (CHANGE 1): if an earlier partial build wrote any rows with
-- frame_tag = 'reorientation', normalize them. Safe no-op on a fresh table.
-- ============================================================
-- update session_memories set frame_tag = 'grounding' where frame_tag = 'reorientation';
