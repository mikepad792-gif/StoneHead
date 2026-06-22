-- ============================================================
-- StoneHead AI — Migration 004: core_memories (Phase 2.5)
-- Reflection-surfaced (and user-pinned) memories. Populated by the
-- consolidation job (Section 3); rendered on the /memory page.
-- frame taxonomy uses the renamed value 'grounding' (not 'reorientation').
-- ============================================================

create table core_memories (
  id                 uuid primary key default uuid_generate_v4(),
  user_id            uuid not null references users(id) on delete cascade,
  text               text not null,
  why_it_carries     text,
  status             text not null default 'active'
                       check (status in ('active', 'superseded')),
  pinned             boolean not null default false,
  source             text not null default 'reflection'
                       check (source in ('reflection', 'user')),
  source_session_ids uuid[] default '{}',
  last_reaffirmed_at timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index idx_core_memories_user_id on core_memories(user_id);

alter table core_memories enable row level security;

create policy "core_memories_select_own" on core_memories for select using (user_id = auth.uid());
create policy "core_memories_update_own" on core_memories for update using (user_id = auth.uid());
create policy "core_memories_delete_own" on core_memories for delete using (user_id = auth.uid());
