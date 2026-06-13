# Plan 001: Restrict Supabase REST Anonymous Write Policy

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9537dd6..HEAD -- README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The current Supabase setup in `README.md` defines `CREATE POLICY "anon insert" ON saved_reels FOR INSERT TO anon WITH CHECK (true);`. This allows anyone on the internet with the public anonymous key to insert arbitrary rows into the database. An attacker could bypass API validation, insert fake reels marked as `status = 'done'` with spam data, or insert hundreds of rows with `status = 'pending'` to flood the worker queue and exhaust Groq API limits.

By restricting this policy, we ensure only valid, incoming Instagram Reel URL links marked as `pending` can be inserted anonymously.

## Current state

The SQL definition resides in `README.md` (lines 174–182):
```sql
-- Allow anonymous reads (dashboard)
CREATE POLICY "anon select" ON saved_reels FOR SELECT TO anon USING (true);

-- Allow anonymous inserts (iPhone Shortcut via REST)
CREATE POLICY "anon insert" ON saved_reels FOR INSERT TO anon WITH CHECK (true);

-- Enable RLS
ALTER TABLE saved_reels ENABLE ROW LEVEL SECURITY;
```

## Scope

**In scope** (the only files you should modify):
- `README.md` (SQL setup commands in documentation)

**Out of scope**:
- Source code in `backend/` or `frontend/` (no changes needed)

## Steps

### Step 1: Update SQL documentation in README.md

Edit the database SQL instructions in `README.md` to tighten the RLS insertion policy. It should only permit insertions if `status` is `'pending'` and the `url` is a valid Instagram Reel URL format.

Target code shape:
```sql
-- Allow anonymous inserts (iPhone Shortcut via REST - restricted to pending reels only)
CREATE POLICY "anon insert" ON saved_reels FOR INSERT TO anon 
WITH CHECK (
  status = 'pending' 
  AND url LIKE 'https://%instagram.com/reel/%'
);
```

**Verify**: Run `git diff README.md` to ensure the old policy `WITH CHECK (true)` is replaced by the refined policy.

## Test plan

### Manual Verification
1. Advise the user to execute the updated `CREATE POLICY` script in their Supabase SQL Editor:
   ```sql
   DROP POLICY "anon insert" ON saved_reels;
   CREATE POLICY "anon insert" ON saved_reels FOR INSERT TO anon 
   WITH CHECK (
     status = 'pending' 
     AND url LIKE 'https://%instagram.com/reel/%'
   );
   ```
2. Verify that trying to insert a row with `status = 'done'` or a non-Instagram URL via Supabase REST API fails (returns `409` or `401/403` policy violation).
3. Verify that inserting a row with `status = 'pending'` and a valid Instagram Reel URL succeeds.

## Done criteria

- [ ] `README.md` has the updated SQL command in the database setup section.
- [ ] No files outside `README.md` are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If `README.md` SQL setup documentation has been restructured or removed.

## Maintenance notes

- Any changes to the default `status` value in Supabase schema (e.g. changing it from `pending`) must be synchronized with this RLS check.
