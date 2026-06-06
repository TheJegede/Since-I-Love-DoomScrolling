# Sub-project C: iPhone Shortcut → Enqueue — Implementation Plan

> **For agentic workers:** This sub-project is mostly Supabase + iOS configuration, not repo code. Steps use checkbox (`- [ ]`) syntax. There are no automated tests — verification is manual (share a reel, confirm a row appears; confirm the anon key cannot read/modify).

**Goal:** Let the user share a reel from Instagram on iPhone and have a `pending` row appear in the Supabase queue, which sub-project B's worker then processes.

**Architecture:** An Apple Shortcut added to the iOS share sheet POSTs directly to Supabase's PostgREST API to INSERT one row. Security comes from an **insert-only RLS policy** scoped to the `anon` role, so the key embedded in the Shortcut can only enqueue Instagram URLs — never read, update, or delete.

**Tech Stack:** Supabase PostgREST + RLS, Apple Shortcuts.

---

## Prerequisites

1. **Sub-projects A + B merged** — `saved_reels` exists in Supabase with `status`/`source` columns; the worker is running locally to drain the queue.
2. Supabase **anon** key on hand (Settings → API → Project API keys → `anon` `public`).
3. The Supabase **project URL** (e.g. `https://abcdxyz.supabase.co`).

---

### Task 1: Insert-only RLS policy in Supabase

**Files:** none (Supabase SQL Editor).

- [ ] **Step 1: Enable RLS and add the insert-only policy**

Run in the Supabase SQL Editor:

```sql
alter table saved_reels enable row level security;

-- anon (the Shortcut) may ONLY insert pending Instagram rows
create policy "anon insert pending reels"
on saved_reels for insert
to anon
with check (
  status = 'pending'
  and url like '%instagram.com/%'
);
```

The backend uses the **service_role** key, which bypasses RLS — the worker and all server endpoints keep full access. The `anon` role now has *only* the insert path above (no select/update/delete until sub-project D adds a select policy).

- [ ] **Step 2: Verify the policy blocks reads (anon cannot select)**

Run from a terminal (substitute your project URL + anon key):

```bash
curl -s "https://<proj>.supabase.co/rest/v1/saved_reels?select=id&limit=1" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
```

Expected: an empty array `[]` or a permission error — **not** your data. (No select policy exists for anon yet.)

- [ ] **Step 3: Verify the policy allows a valid insert**

```bash
curl -s -X POST "https://<proj>.supabase.co/rest/v1/saved_reels" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d '{"url":"https://www.instagram.com/reel/TESTC1/","status":"pending","source":"share","extracted_json":{}}'
```

Expected: HTTP 201 (no body with `return=minimal`). The row appears in `saved_reels` as `pending`.

- [ ] **Step 4: Verify a non-Instagram / non-pending insert is rejected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<proj>.supabase.co/rest/v1/saved_reels" \
  -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://evil.com/x","status":"done","extracted_json":{}}'
```

Expected: `401`/`403` (RLS `with check` violation). Confirms the policy constrains both URL and status.

> Note: `extracted_json` is `not null`, so the Shortcut must send `"extracted_json": {}`. The worker overwrites it with real insights when it processes the row.

---

### Task 2: Build the Apple Shortcut

**Files:** none (iOS Shortcuts app).

- [ ] **Step 1: Create the Shortcut**

In the **Shortcuts** app → **+** → name it `Save to Transcriber`.

- [ ] **Step 2: Accept share-sheet input**

- Shortcut settings (ⓘ / "Details") → enable **Show in Share Sheet**.
- Set **Accepted Types** to **URLs** (and "Safari web pages" if present); turn the rest off.

- [ ] **Step 3: Normalize the shared URL**

Add action **Get URLs from Input** with input = **Shortcut Input**. (Instagram's share can hand over text containing the URL; this extracts the clean URL. Its output variable is **URLs**.)

- [ ] **Step 4: POST to Supabase**

Add action **Get Contents of URL**. Configure:
- **URL:** `https://<proj>.supabase.co/rest/v1/saved_reels`
- **Method:** `POST`
- **Headers:**
  - `apikey` = `<ANON_KEY>`
  - `Authorization` = `Bearer <ANON_KEY>`
  - `Content-Type` = `application/json`
  - `Prefer` = `return=minimal`
- **Request Body:** **JSON**, with fields:
  - `url` (Text) = the **URLs** variable from Step 3
  - `status` (Text) = `pending`
  - `source` (Text) = `share`
  - `extracted_json` (Dictionary) = empty `{}`

- [ ] **Step 5: Confirmation (optional but recommended)**

Add action **Show Notification** → text `Saved to Transcriber ✅`. Gives instant feedback that the share worked.

- [ ] **Step 6: Save.** The Shortcut now appears in the iOS share sheet.

---

### Task 3: End-to-end verification

- [ ] **Step 1: Share a real reel**

In Instagram, open a reel → **Share** (paper-plane / "…") → **share to other apps** → scroll to **Save to Transcriber**. Tap it. Expect the success notification.

- [ ] **Step 2: Confirm the queue row**

In Supabase Table Editor → `saved_reels`: a new `pending` row with the reel URL and `source='share'`.

- [ ] **Step 3: Confirm the worker drains it**

With the local backend running (sub-project B), within ~5–20s the row goes `pending → processing → done` and fills with insights. (A `failed` status here means an IG download block — refresh `cookies.txt` and retry by resetting the row to `pending`.)

- [ ] **Step 4: Clean up the test rows**

Remove the `TESTC1` / any curl-test rows from Task 1 via the Table Editor.

---

## Self-Review

- **Spec coverage (sub-project C):** Shortcut on share sheet → direct Supabase REST insert ✓ (Task 2); insert-only anon RLS, scoped to instagram URLs + pending status ✓ (Task 1); worker (B) processes the enqueued row ✓ (Task 3); anon key cannot read/modify ✓ (Task 1 Steps 2 & 4).
- **Placeholder scan:** `<proj>` and `<ANON_KEY>` are deliberate user-supplied values, called out in Prerequisites — not code placeholders.
- **Consistency:** insert payload (`url`, `status='pending'`, `source='share'`, `extracted_json={}`) matches the `saved_reels` schema from sub-project A and what `claim_next_pending` (B) expects to find.
- **Security:** the only credential leaving the device is the anon key, which RLS restricts to inserting pending Instagram rows. Worst case if leaked: junk-URL enqueues, never data exposure or deletion.
```
