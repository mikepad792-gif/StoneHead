-- 014_rename_misspelled_strains.sql
-- Five strain keys in data/strains.json were misspelled. This migration moves
-- the stored references that point at the old spellings.
--
--   Afgahni-Bullrider -> Afghani-Bullrider   (7 other Afghani* names)
--   Blue-Champange    -> Blue-Champagne      (4 other *Champagne* names)
--   Sour-Chees        -> Sour-Cheese         (its own description opens
--                                             "Sour Cheese is a happy hybrid")
--   Herojuana         -> Herijuana           (real strain name)
--   El-Jeffe          -> El-Jefe             (real strain name)
--
-- WHY A MIGRATION AND NOT JUST A DATA EDIT
-- Strain names are stored as STRINGS in two places, not as foreign keys. Rename
-- the file without this and those rows point at a strain that no longer exists:
-- a liked strain stops resolving, and a remembered one stops being excluded
-- from the bot's no-match card.
--
-- TWO SPELLINGS PER NAME, and this is the part that is easy to miss.
-- liked_strains.strain_name holds whichever form the save path produced:
-- lib/saveIntent.js writes the resolved database key ("Blue-Champange") when
-- retrieval matched, and titleCase() of what the person typed ("Blue
-- Champange") when it did not. Both are updated below.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
-- core_memories.text and session_memories are free prose a model wrote. A
-- string replacement inside somebody's remembered conversation is not a
-- rename, it is an edit to a record of what was said, and the payoff (a
-- correctly spelled strain inside a sentence nobody will re-read) does not
-- come close to justifying it.
--
-- Idempotent: re-running finds nothing left to change.

begin;

-- ── liked_strains ───────────────────────────────────────────────────
-- Both the hyphenated database key and the title-cased typed form.
update public.liked_strains set strain_name = 'Afghani-Bullrider' where strain_name = 'Afgahni-Bullrider';
update public.liked_strains set strain_name = 'Afghani Bullrider' where strain_name = 'Afgahni Bullrider';
update public.liked_strains set strain_name = 'Blue-Champagne'    where strain_name = 'Blue-Champange';
update public.liked_strains set strain_name = 'Blue Champagne'    where strain_name = 'Blue Champange';
update public.liked_strains set strain_name = 'Sour-Cheese'       where strain_name = 'Sour-Chees';
update public.liked_strains set strain_name = 'Sour Cheese'       where strain_name = 'Sour Chees';
update public.liked_strains set strain_name = 'Herijuana'         where strain_name = 'Herojuana';
update public.liked_strains set strain_name = 'El-Jefe'           where strain_name = 'El-Jeffe';
update public.liked_strains set strain_name = 'El Jefe'           where strain_name = 'El Jeffe';

-- ── bot_usage.recent_strains ────────────────────────────────────────
-- Keys only: note_strain_shown() is handed the resolved database name, never
-- a typed phrase. array_replace rewrites in place and leaves order alone,
-- which matters because the list is most-recent-first.
update public.bot_usage
   set recent_strains = array_replace(recent_strains, 'Afgahni-Bullrider', 'Afghani-Bullrider')
 where 'Afgahni-Bullrider' = any(recent_strains);

update public.bot_usage
   set recent_strains = array_replace(recent_strains, 'Blue-Champange', 'Blue-Champagne')
 where 'Blue-Champange' = any(recent_strains);

update public.bot_usage
   set recent_strains = array_replace(recent_strains, 'Sour-Chees', 'Sour-Cheese')
 where 'Sour-Chees' = any(recent_strains);

update public.bot_usage
   set recent_strains = array_replace(recent_strains, 'Herojuana', 'Herijuana')
 where 'Herojuana' = any(recent_strains);

update public.bot_usage
   set recent_strains = array_replace(recent_strains, 'El-Jeffe', 'El-Jefe')
 where 'El-Jeffe' = any(recent_strains);

commit;

-- Verification. Both should come back 0.
--
--   select count(*) from public.liked_strains
--    where strain_name in ('Afgahni-Bullrider','Afgahni Bullrider','Blue-Champange',
--                          'Blue Champange','Sour-Chees','Sour Chees','Herojuana',
--                          'El-Jeffe','El Jeffe');
--
--   select count(*) from public.bot_usage
--    where recent_strains && array['Afgahni-Bullrider','Blue-Champange',
--                                  'Sour-Chees','Herojuana','El-Jeffe'];
