-- 021_avatars.sql
-- Profile avatars (v2.1.2). The id of the picked avatar, from src/avatars.js;
-- null means the letter avatar. Saved through api/profile-settings.js with the
-- service key, which checks the id and the 21+ gate, so no client policy.
-- Safe to run again.

alter table public.users add column if not exists avatar_id text;
