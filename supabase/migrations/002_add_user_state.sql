-- ============================================================
-- StoneHead AI — Migration 002: Add user_state
-- Stores the user's US state for future legal-state gating
-- and location-based features (dispensary search, deals near me).
-- Not acted on yet — just collected at signup.
-- ============================================================

alter table users
  add column user_state text default null;

-- Optional: add a check constraint for valid US state codes
-- Leaving unconstrained for now to allow non-US users to enter
-- their region freely. Can tighten later if needed.
