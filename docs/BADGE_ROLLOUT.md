# Badge System (First Artist) — Rollout Runbook

Deploy-order companion to `supabase/migrations/007_badge_system.sql`.
Unlike the founder rollout, **order barely matters here** — both orders are
safe — but run the migration first anyway so you never see the fallback path.

## Why this is low-risk by construction

- **Founder is untouched.** No change to `users` columns, `chat-send.js`'s
  gate bypass, `grant-founder.mjs`, or the founder badge render. The new
  system is separate tables that physically cannot reach the paywall.
- **Code-before-migration is harmless.** `getUserBadges` returns `[]` on any
  error (including "table does not exist"), so `profile-get` keeps working
  and the strip just shows nothing new.
- **Migration-before-code is harmless.** Nothing deployed reads the new
  tables until the code ships.

## Step 0 — Migration

Supabase SQL editor → paste `supabase/migrations/007_badge_system.sql` → run.
Verify:

- `badges` and `user_badges` tables exist, RLS **enabled** on both.
- `badges` has one row: `first_artist`, cap `1`, perks `{}`.
- Site behavior unchanged — send a message, open profile.

## Step 1 — RLS security check (the guarantee, verify it explicitly)

In the SQL editor, impersonate the anon role:

```sql
set local role anon;            -- inside a transaction: begin; ... rollback;
select * from public.badges;    -- should return the first_artist row
insert into public.user_badges (user_id, badge_key)
  values ('00000000-0000-0000-0000-000000000000', 'first_artist');
                                 -- should FAIL: no insert policy
```

(Or hit PostgREST with the anon key.) Reads succeed, writes are denied —
the browser can never grant itself a badge.

## Step 2 — Deploy the code

Ships: `lib/getUserBadges.js`, `lib/userHasPerk.js` (dormant, called by
nothing), `badges` array on `/api/profile/get`, badge strip in the profile
modal. Regression check after deploy: a founder account still shows
**og sesher #N** and still has unlimited messages.

## Step 3 — Test grant (use yourself, not the real recipient)

`first_artist` is cap-1, so test on yourself, verify, then revoke by hand
before the real grant:

```
node scripts/grant-badge.mjs <your-username> first_artist
```

- Expect: `Granted First Artist #1 to <you> (...). 0 slot(s) left.`
- Re-run → `already holds First Artist #1. No change.` (idempotency)
- Grant to a *different* account → refused on cap.
- Profile modal shows the terracotta **first artist #1** under the founder
  badge (after a reload — badges load with the profile).

Revoke the test grant (no revoke flag on the script — cap-1 badges are a
one-time decision, so revoke is deliberately manual):

```sql
delete from public.user_badges
 where badge_key = 'first_artist'
   and user_id = (select id from public.users where username = '<you>');
```

Numbering is max+1, so after deleting your test #1 the real recipient
still gets #1.

## Step 4 — The real grant

```
node scripts/grant-badge.mjs <their-username-or-email> first_artist
```

Cap-1 means this closes the door — pick the recipient before running it.

## Adding badge #2 someday

One insert, no migration, no deploy:

```sql
insert into public.badges (key, label, color, cap, perks)
  values ('some_badge', 'Some Badge', '#8a6ade', null, '{}'::jsonb);
```

Then `node scripts/grant-badge.mjs <who> some_badge`. If a future badge
ever needs a *perk*, wire it server-side through `lib/userHasPerk.js`
(default-deny) — and read that file's header first.
