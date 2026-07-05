# OG Sesher (Founding Member) — Rollout Runbook

Do this awake and watching, in this order. Each step is safe on its own and
verifiable before the next. CryptAxe already has unlimited access the manual
way (`is_subscribed=true`), so there is zero urgency — nothing here needs to
happen tonight.

## Why this exact order

- **The migration must run BEFORE the code deploys.** The new gate code
  `select`s `is_founder` / `founder_number`; if the code goes live first,
  every chat-send 500s on the missing column. The reverse order is harmless:
  no live query does `select *`, every query names its columns, so the new
  columns are invisible to the running site.
- **The founder-override test only means something AFTER the gate code is
  live.** With only the columns + grant in place, nothing deployed reads
  `is_founder` yet — flipping your own `is_subscribed` to false at that point
  would cap you like a free user and look like a failure. That's expected,
  not broken.

## Step 0 — Migration (safe any time, zero user impact)

Supabase SQL editor → paste `supabase/migrations/006_founding_members.sql`
→ run. Verify: `users` shows `is_founder` (false everywhere),
`founder_number` (null), `founder_granted_at` (null). Site behavior
unchanged — send a message to confirm.

## Step 1 — Mint YOURSELF as the test founder (not CryptAxe)

From the repo folder on your machine (needs `.env` with `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY`):

```
node scripts/grant-founder.mjs <your-username>
```

Expect: `Granted OG Sesher #1 to <you> (...). 9 slot(s) left.`
Run it again → `already OG Sesher #1. No change.` (idempotency check).
You now have `is_subscribed=true`, so you're unlimited via the EXISTING
path even before the new code ships.

## Step 2 — Merge the PR (both commits) and wait for the Netlify deploy

Rollback story if anything misbehaves: the gate + badge live in their own
commit — `git revert` that one commit alone; the schema and your grant
persist harmlessly (columns go back to being ignored).

## Step 3 — THE test: prove the founder override on your own account

In Supabase, set your own row's `is_subscribed = false`. Then in the app:

- You can still send messages past `FREE_DAILY_LIMIT` (this is CHANGE 3b
  working — the only thing that will stand between a founder and a broken
  experience).
- Usage badge shows no daily cap (`usage_remaining: null`).
- Profile modal shows the amber `★ og sesher #1` badge.
- A NORMAL free account still shows the counter and still caps — confirm
  with a second account if you have one.

## Step 4 — Un-mint yourself, then mint CryptAxe as #1

Your grant was a test, not a claim on a slot. Revoke it:

```
node scripts/grant-founder.mjs --revoke <your-username>
```

This clears your founder fields, frees the slot, and resets your
`is_subscribed` to false (you're back to free tier — expected; confirm the
daily counter shows for you again, which double-checks the gate in the
other direction). Because numbering is max+1 and no founders remain, the
next grant gets #1:

```
node scripts/grant-founder.mjs <cryptaxe-username>
```

→ `Granted OG Sesher #1 to CryptAxe (...). 9 slot(s) left.` All 10 slots
stay mintable for real people.

Revoke is operator-CLI only — nothing in the app can ever revoke a
founder; this command exists purely so your test grant doesn't burn a
slot.

## Cap notes

- `FOUNDER_CAP = 10` lives at the top of `scripts/grant-founder.mjs` — the
  one edited constant.
- The 11th grant refuses and writes nothing. Re-runs on existing founders
  never consume a slot.
- There is deliberately NO endpoint for this. Grants happen only from an
  operator machine with the service-role key.
