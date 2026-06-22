-- ============================================================
-- StoneHead AI — Migration 005: Phase 2.5 column tweaks
-- ============================================================

-- 0a. The save resolver now stores the literal term a user said when it
-- can't confidently resolve a dataset row (a correct user-typed name beats
-- a confident wrong match). Those rows have no strain_type, so allow null.
-- NOTE: the existing CHECK (strain_type in ('indica','sativa','hybrid'))
-- passes on null (null IN (...) is unknown, which a CHECK treats as pass),
-- so only the NOT NULL needs dropping.
alter table liked_strains alter column strain_type drop not null;

-- Section 3. Per-user marker for the consolidation trigger: the job fires
-- only when >= 15 new session_memories were written after this timestamp
-- (fresh ground truth arrived), never on a timer over a frozen base.
alter table users add column last_consolidated_at timestamptz default null;
