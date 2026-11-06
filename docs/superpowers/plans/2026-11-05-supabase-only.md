# Retire the HF Backend (Supabase + Home Worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Hugging Face backend. The dashboard talks only to Supabase, with the owner signed in by email link, and the home worker processes every kind of job.

**Architecture:** Every dashboard action becomes a row in Supabase. Reel work is a `pending` row in `saved_reels`, and recompute is a row in `cluster_jobs`. The existing home worker (`backend/run_worker.py`, a Windows scheduled task every 5 minutes) picks those rows up. Row-level security lets one owner account do everything; the anonymous key keeps only the iPhone Shortcut's insert. The rollout is additive first (Tasks 0–8) and subtractive after a soak period (Tasks 9–11). Every step has a rollback.

**Tech Stack:** Python 3.11, supabase-py, Groq, fastembed, scikit-learn (worker) · React 19, Vite, supabase-js 2.107 (dashboard) · Supabase Postgres + pgvector + Auth + Storage.

**Spec:** the Design section below, agreed with the owner on 2026-11-05. There is no separate spec file.

## Design

| Action | Today | After |
|---|---|---|
| Share from iPhone | Shortcut → Supabase insert (anon key) | **Unchanged** |
| Paste URL | HF inserts a `pending` row | Browser inserts a `pending` row, `source='dashboard'` |
| Bulk import | HF parses the file and inserts rows | Browser parses the file and inserts `pending` rows, `source='batch'` |
| Paste text | HF runs the LLM immediately | Browser inserts a `pending` row with `raw_transcript`/`post_caption`, `source='text'`; worker extracts |
| Audio file | HF transcribes immediately | Browser uploads to Storage bucket `audio-uploads` and inserts a `pending` row with `audio_path`, `source='audio'`; worker transcribes, then deletes the file |
| Recompute clusters | HF background task | Browser inserts a `cluster_jobs` row; worker runs it |
| Retry / delete | HF endpoints + API token | Browser updates/deletes rows directly as the owner |
| Reads, search | Anon key | Signed-in owner (anon read removed in Task 9) |
| "Backend online" banner | HF `/health` | Worker heartbeat (`worker_status.last_seen`) |

**What the worker does with a claimed `pending` row** (first match wins):
1. `url` set → the existing download pipeline, unchanged.
2. `audio_path` set → download from Storage → transcribe → silent-hook guard (caption = `post_caption`) → extract → save → delete the Storage file. On failure the file is kept so a retry can use it.
3. `raw_transcript` or `post_caption` non-empty → extract → save. No silent-hook guard (same as today's `/extract/text`).
4. Otherwise → `mark_failed(id, "Nothing to process: no URL, audio or text.")`.

Retry rules stay as they are for every kind: `MAX_WORKER_ATTEMPTS = 3`, transient errors back off, and caption-only fallback happens only on the final attempt. When no reel is waiting, the worker claims the oldest `pending` `cluster_jobs` row. It writes a heartbeat at start and after every job.

**Access:**
- One Supabase Auth user is the owner. Sign-ups are disabled.
- Policies call `public.is_owner()` (`auth.uid()` equals the owner's UUID).
- `anon` keeps exactly one permission: the existing `"anon insert pending reels"` policy.
- The worker keeps the service key, which bypasses row-level security.

**Accepted trade-offs:**
- Nothing is processed while the PC is off. That now includes text, audio and recompute; the worker banner makes it visible.
- Text and audio results arrive within the worker schedule (up to 5 minutes) instead of instantly.

## Global Constraints

- $0/month: free tiers only. No new npm or pip packages (supabase-js and supabase-py are already installed).
- Do **not** modify the `"anon insert pending reels"` policy or the iPhone Shortcut (owner decision, 2026-11-05).
- SQL runs only in the Supabase SQL Editor (there is no direct database access). Before every Run: show the exact statement, get the owner's explicit yes, and have that task's rollback SQL at hand.
- No data is deleted during the migration. The HF Space is **paused**, not deleted, in Task 10.
- Never commit the owner's email or UUID. SQL in this repo uses the placeholder `<OWNER_UUID>`, which is filled in only inside the SQL Editor.
- Develop in a git worktree on branch `feat/supabase-only`. The scheduled worker runs the main working copy (`C:\Users\jeged\Downloads\Transcriber\backend\run_worker.py`), so main's checkout must always hold working code. Pushing `main` deploys Vercel production.
- Worktree tests reuse the main venv: `C:\Users\jeged\Downloads\Transcriber\backend\.venv\Scripts\python.exe -m pytest backend`. Groq and Supabase are mocked; tests never touch the real database.
- Frontend checks, from `frontend/`: `npm test` and `npm run lint`.
- Styles go in `App.css`; no inline `style` except for values computed at runtime. Every degraded state must be visible to the user.
- Audio uploads are capped at 25 MB (26214400 bytes), Groq Whisper's limit.
- Exact identifiers:
  - Storage bucket `audio-uploads`
  - Tables `cluster_jobs` and `worker_status`
  - Column `saved_reels.audio_path`
  - New `source` values `dashboard`, `batch`, `text`, `audio`
  - Failure statuses `failed`, `cookies_expired`, `unsupported_format`

## Review Focus

1. **Signed out or session expired.** Row-level security returns empty results, not errors. The app must show the login screen, never an empty library. → Task 6 test `shows login and never queries reels when signed out`.
2. **Email link opened on another device or browser** (for example the phone's mail app). Sign-in must still work. → `flowType: 'implicit'` is pinned in `supabaseClient.js` (Task 6 test) and checked by hand in Task 8.
3. **Audio uploaded but the row insert fails.** No orphan file may be left behind. → Task 5 test `queueAudio removes the uploaded file when the row insert fails`.
4. **PC worker off for hours.** Queued items need a visible explanation. → Task 7 test `shows the worker banner when the worker is stale and something is queued`.
5. **Bulk file with more than 100 reels, repeated URLs and already-saved URLs.** Lookups must be chunked and no duplicates inserted. → Task 5 test `queueBulk skips repeats and saved reels across chunks`.

## Rollback Map

| After task | To undo |
|---|---|
| 1 | Task 1 rollback SQL. The new objects are empty and unused until Task 8. |
| 2 | Task 2 rollback SQL; re-enable sign-ups if wanted. |
| 3–7 | Code only exists on the branch. Delete the branch. |
| 8 | `git revert -m 1 <merge sha>` and push. HF is still running, so the old dashboard works. First let the new worker drain any `text`/`audio` rows. |
| 9 | Re-create `"anon read reels"` from the definition recorded in Task 0. |
| 10 | Unpause the HF Space and `git revert <sha>`. |

---

### Task 0: Safety net — backup and record current policies

**Files:**
- Create: `backend/export_reels.py`
- Modify: `.gitignore` (add `backups/`)
- Create: `docs/sql/policies-before-supabase-only.md`
- Test: `backend/test_pipeline.py`

**Interfaces:**
- Produces: `export_reels.export(path: pathlib.Path) -> int`. It writes every `saved_reels` row (all columns, paged with `db._select_newest_first("*")`) as a JSON array and returns the row count.

- [ ] **Step 1: Failing test** `test_export_writes_every_row`. Monkeypatch `db._select_newest_first` to return 3 rows and call `export(tmp_path / "r.json")`. Assert the return value is `3` and that `json.loads` of the file equals the 3 rows.
- [ ] **Step 2: Run it and confirm it fails.** `...python.exe -m pytest backend -k export_writes -v` → FAIL (no module `export_reels`).
- [ ] **Step 3: Implement `export(path)`** plus a `__main__` block that writes `backups/reels-<YYYY-MM-DD>.json` at the repo root and prints the count.
- [ ] **Step 4: Run the test** → PASS.
- [ ] **Step 5: Run the real export once** from the main working copy: `backend\.venv\Scripts\python.exe backend\export_reels.py`. Expected: a printed count of at least 859, and the file exists.
- [ ] **Step 6: Record the current policies.** Run this read-only query in the SQL Editor (owner says yes first) and paste the result table into `docs/sql/policies-before-supabase-only.md`:

```sql
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname in ('public', 'storage')
order by tablename, policyname;
```

- [ ] **Step 7: Commit** `export_reels.py`, the test, `.gitignore` and the policies doc.

### Task 1: Schema additions (additive SQL)

**Files:**
- Create: `docs/sql/supabase-only.sql`, containing this task's SQL, Task 2's SQL and every rollback block, verbatim.

**Interfaces:**
- Produces:
  - `saved_reels.audio_path text`
  - `cluster_jobs(id uuid, status text, created_at, started_at, finished_at, assigned int, error text)`
  - `worker_status(id int = 1, last_seen timestamptz)`
  - Storage bucket `audio-uploads`

- [ ] **Step 1: Owner says yes, then run:**

```sql
alter table public.saved_reels add column if not exists audio_path text;

create table if not exists public.cluster_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  assigned integer not null default 0,
  error text
);
-- at most one queued-or-running recompute, enforced by the database
create unique index if not exists cluster_jobs_one_active
  on public.cluster_jobs ((true)) where status in ('pending', 'running');
alter table public.cluster_jobs enable row level security;

create table if not exists public.worker_status (
  id integer primary key default 1 check (id = 1),
  last_seen timestamptz not null
);
alter table public.worker_status enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio-uploads', 'audio-uploads', false, 26214400, array['audio/*'])
on conflict (id) do nothing;
```

If the `storage.buckets` insert is refused, create the bucket in Storage → New bucket instead: name `audio-uploads`, Public off, file size limit 25 MB, allowed MIME type `audio/*`.

- [ ] **Step 2: Verify.** Run `select column_name from information_schema.columns where table_name = 'saved_reels' and column_name = 'audio_path';` → 1 row. Then `select id, public from storage.buckets where id = 'audio-uploads';` → `public = false`.
- [ ] **Step 3: Check that sharing still works.** Share one reel from the iPhone; it appears in the dashboard as queued.

Rollback (the new objects are still empty):

```sql
delete from storage.buckets where id = 'audio-uploads';
drop table if exists public.worker_status;
drop table if exists public.cluster_jobs;
alter table public.saved_reels drop column if exists audio_path;
```

- [ ] **Step 4: Commit** `docs/sql/supabase-only.sql`.

### Task 2: Owner account and owner policies

**Files:**
- Modify: `docs/sql/supabase-only.sql` (append this task's SQL and rollback)

**Interfaces:**
- Produces:
  - `public.is_owner() returns boolean`
  - Policies `"owner all reels"`, `"owner all cluster jobs"`, `"owner reads worker status"` and `"owner audio uploads"`
  - Auth redirect URLs that allow production, localhost and Vercel previews

- [ ] **Step 1: Create the owner account (the owner does this in the dashboard).** Authentication → Users → Add user → Create new user with the owner's email, "Auto Confirm User" on. Copy the user's UUID and keep it out of git.
- [ ] **Step 2: Turn off sign-ups.** Authentication → Sign In / Providers → turn off "Allow new users to sign up".
- [ ] **Step 3: Set the URL configuration** (Authentication → URL Configuration):
  - Site URL: `https://reels-transcriber.vercel.app`
  - Redirect URLs:
    - `https://reels-transcriber.vercel.app/**`
    - `http://localhost:5173/**`
    - this project's Vercel preview pattern, taken from any preview URL, in the form `https://reels-transcriber-git-*-<team-slug>.vercel.app/**`

  Never add a bare `https://*.vercel.app/**`: any Vercel site could then receive your sign-in tokens.
- [ ] **Step 4: Owner says yes, then run** (with `<OWNER_UUID>` replaced inside the editor only):

```sql
create or replace function public.is_owner() returns boolean
language sql stable set search_path = ''
as $$ select auth.uid() = '<OWNER_UUID>'::uuid $$;

create policy "owner all reels" on public.saved_reels for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy "owner all cluster jobs" on public.cluster_jobs for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
create policy "owner reads worker status" on public.worker_status for select to authenticated
  using (public.is_owner());
create policy "owner audio uploads" on storage.objects for all to authenticated
  using (bucket_id = 'audio-uploads' and public.is_owner())
  with check (bucket_id = 'audio-uploads' and public.is_owner());
```

- [ ] **Step 5: Verify nothing changed for today's site.** From `frontend/`, run `node --env-file=.env.local -e "require('@supabase/supabase-js').createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY).from('saved_reels').select('id', { count: 'exact', head: true }).then(r => console.log(r.count, r.error))"` → the same count as Task 0, and `null` for the error. Load the live dashboard → the library shows. The owner policies are exercised in Task 8.

Rollback:

```sql
drop policy if exists "owner audio uploads" on storage.objects;
drop policy if exists "owner reads worker status" on public.worker_status;
drop policy if exists "owner all cluster jobs" on public.cluster_jobs;
drop policy if exists "owner all reels" on public.saved_reels;
drop function if exists public.is_owner();
```

- [ ] **Step 6: Commit** `docs/sql/supabase-only.sql`.

### Task 3: Worker handles text and audio rows

**Files:**
- Modify: `backend/db.py`, `backend/main.py` (`process_pending_reel`)
- Test: `backend/test_pipeline.py`

**Interfaces:**
- Consumes: `saved_reels.audio_path` and the `audio-uploads` bucket (Task 1).
- Produces:
  - In `db.py`: `AUDIO_BUCKET = "audio-uploads"`, `db.download_audio(path: str) -> bytes` and `db.delete_audio(path: str) -> None`. Both use `get_client().storage.from_(AUDIO_BUCKET)`.
  - In `main.py`: `process_pending_reel(row: dict) -> None` dispatches on the Design's four rules. `update_reel_result` keeps the row's own `title` for text and audio rows, and the downloaded title for URL rows.

- [ ] **Step 1: Write the failing tests** (reuse the `pipeline` fixture and `raiser`):
  - `test_worker_processes_text_row`. Row `{"id": "t1", "url": None, "audio_path": None, "title": "Notes", "raw_transcript": LONG_TRANSCRIPT, "post_caption": "cap", "attempt_count": 1}`. `worker_tick()` calls `extract_structured_json(LONG_TRANSCRIPT, "cap")` and `update_reel_result` with `title="Notes"` and `status="done"`. `download_and_extract_audio` is never called.
  - `test_worker_processes_audio_row_and_deletes_file`. `audio_path="a1.m4a"` and `db.download_audio` returns `b"audio"`. `transcribe_audio` gets a path ending `.m4a` whose bytes are `b"audio"`. `update_reel_result` gets `raw_transcript=LONG_TRANSCRIPT`. `db.delete_audio("a1.m4a")` is called after `update_reel_result`. The temp file no longer exists.
  - `test_audio_row_keeps_file_when_transcription_fails`. `transcribe_audio` raises `HTTPException(500, "x")` on attempt 1 → `db.schedule_retry` is called and `db.delete_audio` is not.
  - `test_audio_row_without_speech_or_caption_fails`. Transcript `""` and `post_caption=None` → `mark_failed` with a detail containing `"No spoken audio"`, and `delete_audio` is not called.
  - `test_row_with_nothing_to_process_fails` → `mark_failed("n1", "Nothing to process: no URL, audio or text.")`.
  - `test_done_reel_survives_audio_cleanup_failure`. `delete_audio` raises → still exactly one `update_reel_result` call and no `mark_failed`.
- [ ] **Step 2: Run them** with `-k "text_row or audio_row or nothing_to_process or cleanup_failure"` → FAIL.
- [ ] **Step 3: Implement.** Add the `db.py` helpers. In `main.py`, split `process_pending_reel` into the dispatch plus `_extract_from_audio_row(row, allow_caption_fallback) -> tuple[str, ReelExtraction]` (returns transcript and extraction; writes a `tempfile.NamedTemporaryFile(delete=False, suffix=<ext of audio_path>)` and removes it in `finally`) and `_extract_from_text_row(row) -> ReelExtraction`. Keep the existing `HTTPException` handling, retry and status mapping around all three kinds. A `delete_audio` failure after a successful save only logs a warning.
- [ ] **Step 4: Run the full suite:** `...python.exe -m pytest backend` → all pass, including the existing URL-row worker tests unchanged.
- [ ] **Step 5: Commit.**

### Task 4: Worker runs cluster jobs and writes a heartbeat

**Files:**
- Modify: `backend/db.py`, `backend/main.py`
- Test: `backend/test_pipeline.py`

**Interfaces:**
- Consumes: the `cluster_jobs` and `worker_status` tables (Task 1).
- Produces:
  - `db.claim_next_cluster_job() -> Optional[dict]`. Oldest `pending` row, flipped to `running` with `started_at=now`, compare-and-set on `status` like `claim_next_pending`; returns `None` if the claim is lost.
  - `db.finish_cluster_job(job_id: str, status: str, assigned: int = 0, error: Optional[str] = None) -> None`. Sets `finished_at`; `error` is truncated to 500 characters.
  - `db.recover_stale_cluster_jobs(stale_before: datetime) -> int`. Moves `running` jobs with `started_at < stale_before` back to `pending`.
  - `db.heartbeat() -> None`. Upserts `{"id": 1, "last_seen": now}` into `worker_status`.
  - `main.recompute_clusters() -> int`. The body of today's `run_cluster_recompute_task`, including `_recluster_late_reels`; returns the number of reels assigned. `run_cluster_recompute_task` becomes a thin wrapper that still updates `CLUSTER_JOB`, so HF behaviour is unchanged until Task 10.
  - `main.run_cluster_job(job: dict) -> None`. Calls `finish_cluster_job` with `"done"` and the count, or `"error"` and the message.
  - `worker_tick() -> bool`. Heartbeat, then one reel; if no reel was claimed, one cluster job.
  - `run_worker()` also calls `recover_stale_cluster_jobs`.

- [ ] **Step 1: Write the failing tests:**
  - `test_worker_runs_cluster_job_when_no_reels_queued`. `claim_next_pending` → `None` and `claim_next_cluster_job` → `{"id": "j1"}`; `recompute_clusters` returns 7 → `finish_cluster_job("j1", "done", 7)`, and `worker_tick()` returns `True`.
  - `test_reels_go_before_cluster_jobs`. With a claimable reel, `claim_next_cluster_job` is not called.
  - `test_cluster_job_failure_is_recorded`. `recompute_clusters` raises `RuntimeError("boom")` → `finish_cluster_job("j1", "error", error="boom")`.
  - `test_heartbeat_failure_does_not_stop_the_worker`. `db.heartbeat` raises → the reel is still processed.
  - `test_run_worker_recovers_stale_cluster_jobs`. `run_worker(drain=True)` calls `recover_stale_cluster_jobs` once.
  - `test_claim_next_cluster_job_returns_none_when_race_lost`. Use a `RecordingTable` whose update returns `data=[]`.
  - The existing `test_recompute_clusters` and `test_recompute_reclusters_reels_saved_while_it_ran` stay green.
- [ ] **Step 2: Run them** → FAIL.
- [ ] **Step 3: Implement** to the signatures above. Wrap `db.heartbeat()` so a failure only logs a warning.
- [ ] **Step 4: Run the full suite** → all pass.
- [ ] **Step 5: Commit.**

### Task 5: Frontend data layer (`instagramUrl.js`, `queue.js`)

**Files:**
- Create: `frontend/src/instagramUrl.js`, `frontend/src/queue.js`
- Modify: `frontend/src/supabaseClient.js` (export `REEL_COLUMNS`, now including `audio_path`; `rowToRecord` passes `audio_path` through), `frontend/src/test/fakeSupabase.js` (an in-memory table store supporting `insert/update/delete/select/eq/in/gt/order/limit/maybeSingle/single`, a `storage.from().upload/remove` recorder, and injectable errors)
- Test: `frontend/src/test/instagramUrl.test.js`, `frontend/src/test/queue.test.js`

**Interfaces:**
- Produces from `instagramUrl.js`. These mirror `backend/saved_parser.py` exactly and must change together with it:
  - `normalizeInstagramUrl(url: string) -> string`
  - `isValidInstagramReel(url: string) -> boolean`
  - `parseSavedPosts(data: Array) -> Array<{url, caption, title}>` (reels only, first occurrence wins)
- Produces from `queue.js`. Every function throws an `Error` with a user-facing message on failure:
  - `queueReelUrl(rawUrl) -> Promise<record>`. Invalid → `'Invalid Instagram Reel URL format.'`. An existing row with the same normalized URL is returned as-is. Otherwise it inserts `{id: crypto.randomUUID(), url, status: 'pending', source: 'dashboard', raw_transcript: '', extracted_json: {}}` and returns `rowToRecord` of the inserted row.
  - `queueText({title, transcript, caption}) -> Promise<record>`. Both empty → `'Please provide either a transcript or a description caption.'`. Inserts `title || 'Manual Text Input'`, `source: 'text'`.
  - `queueAudio({file, title, caption}) -> Promise<record>`. `file.size > 26214400` → `'Audio files must be 25 MB or smaller.'`, with no upload. Uploads to `<uuid>.<ext or mp3>` with `contentType: file.type`, then inserts `audio_path`, `title || file.name`, `post_caption: caption`, `source: 'audio'`. If the insert fails, it calls `storage.remove([path])` and rethrows.
  - `queueBulk(data) -> Promise<{total, enqueued, existing, urls}>`. No reels → `'No reel URLs found in the uploaded file.'`. Existing-URL lookup in chunks of 100; inserts in chunks of 50 with `source: 'batch'`.
  - `retryReel(id) -> Promise<void>`. Update with `.in('status', FAILURE_STATUSES)`. Nothing updated → `'Reel not found or not in a retryable failure state.'`
  - `deleteReel(reel) -> Promise<void>`. Deletes the row first, then `storage.remove([reel.audio_path])` when it is set. A file-removal failure is only logged.
  - `requestClusterRecompute() -> Promise<void>`. Inserts `{}` into `cluster_jobs`. Error code `'23505'` (one is already active) counts as success.
  - `latestClusterJob() -> Promise<job | null>`

- [ ] **Step 1: Write the failing tests:**
  - `instagramUrl.test.js`:
    - `normalizeInstagramUrl('https://instagram.com/reels/ABC/?igsh=1') === 'https://www.instagram.com/reel/ABC/'`
    - `/p/XYZ` keeps `/p/`
    - `isValidInstagramReel('https://google.com') === false`
    - `parseSavedPosts` drops `/p/` posts and the repeat of a reel (same fixture as `test_parse_saved_posts`)
  - `queue.test.js`:
    - `queueReelUrl returns the saved row instead of inserting a duplicate`
    - `queueReelUrl inserts a normalized pending dashboard row`
    - `queueAudio rejects files over 25 MB without uploading`
    - `queueAudio removes the uploaded file when the row insert fails`
    - `queueBulk skips repeats and saved reels across chunks`: 150 entries, 2 repeats, 3 already saved → `{total: 148, enqueued: 145, existing: 3}`, and every `in` lookup has at most 100 values
    - `retryReel throws when no failed reel matched`
    - `requestClusterRecompute treats an already-active job as success`
    - `deleteReel removes the audio file after the row`
- [ ] **Step 2: Run** `npm test -- instagramUrl queue` → FAIL.
- [ ] **Step 3: Implement** to the interfaces above. `FAILURE_STATUSES = ['failed', 'cookies_expired', 'unsupported_format']`.
- [ ] **Step 4: Run** `npm test` and `npm run lint` → pass.
- [ ] **Step 5: Commit.**

### Task 6: Sign-in and session gate

**Files:**
- Create: `frontend/src/useSession.js`, `frontend/src/components/Login.jsx`
- Modify: `frontend/src/supabaseClient.js` (`createClient(url, anonKey, { auth: { flowType: 'implicit', persistSession: true, detectSessionInUrl: true } })`), `frontend/src/App.jsx` (gate plus a "Sign out" button in `.header-meta`), `frontend/src/App.css`
- Test: `frontend/src/test/auth.test.jsx`

**Interfaces:**
- Produces:
  - `useSession() -> { session, loading }`. Reads `supabase.auth.getSession()` and subscribes with `onAuthStateChange`; unsubscribes on unmount.
  - `<Login />`. An email form calling `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: window.location.origin } })`. On success it shows "Check your email for a sign-in link." Supabase's error message, including rate limits, is shown as given.
  - App: `loading` → the existing skeletons; no session → `<Login />`; signed in → today's app. Reels are fetched only when a session exists.

- [ ] **Step 1: Write the failing tests:**
  - `shows login and never queries reels when signed out`. `getSession` → `{ session: null }` → the email field is shown and `from('saved_reels')` is never called.
  - `shows the library when signed in`
  - `returns to login on SIGNED_OUT`
  - `requests a link without creating users`. `signInWithOtp` is called with `shouldCreateUser: false`.
  - `pins the implicit auth flow`. `vi.mock('@supabase/supabase-js')`, `vi.stubEnv` both `VITE_SUPABASE_*` values, import `supabaseClient` → `createClient` received `auth.flowType === 'implicit'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `npm run lint` → pass. Update the `App.test.jsx`/`App.search.test.jsx` mocks to a signed-in session.
- [ ] **Step 5: Commit.**

### Task 7: Dashboard writes go to Supabase; worker banner replaces the health check

**Files:**
- Create: `frontend/src/useWorkerStatus.js`
- Modify: `frontend/src/components/IngestionPanel.jsx`, `frontend/src/App.jsx`, `frontend/src/App.css`
- Delete: `frontend/src/api.js`
- Test: `frontend/src/test/App.test.jsx`, `frontend/src/test/IngestionPanel.test.jsx`

**Interfaces:**
- Consumes: everything in `queue.js` (Task 5).
- Produces:
  - `useWorkerStatus() -> { lastSeen: Date | null }`. Reads `worker_status` once and then every 30 s.
  - `isWorkerStale(lastSeen, now) -> boolean`. True when `lastSeen` is null or more than 15 minutes old.
  - The banner shows when the worker is stale **and** (any reel is `pending`/`processing` **or** the latest cluster job is `pending`). Copy:
    - stale: "Your PC worker last ran {N minutes/hours/days} ago — queued items will be processed when it runs again."
    - never seen: "Your PC worker hasn't checked in yet — queued items will be processed once it runs."
  - IngestionPanel:
    - URL, text and audio call the `queue.js` functions, then `onIngested(record)`. The modal shows the existing queue banner.
    - Bulk calls `queueBulk`, then `onBatchQueued()` (App runs `fetchReels()` once). Progress is derived from the `reels` prop for the returned `urls`: done = status `done`, failed = a failure status, anything else or missing = active.
  - App:
    - Retry, delete and recompute call `queue.js`.
    - The recompute button reads "Queued…" while the latest job is `pending` and "Clustering…" while it is `running`, and is disabled for both.
    - It polls `latestClusterJob()` every 3 s while a job is active. On `done` it runs `fetchReels()`; on `error` it calls `setError(job.error)`.
    - The `/health` effect, `isWakingUp` and the "connecting" banner are removed.

- [ ] **Step 1: Write the failing tests:**
  - `queues a pasted URL and opens it as queued` → a row is inserted and "In Ingestion Queue" is shown.
  - `retries a failed reel from the card`
  - `deletes a reel`
  - `recompute shows Queued, then refreshes when the job is done`
  - `shows the worker banner when the worker is stale and something is queued` (`last_seen` 2 h ago plus one pending reel)
  - `hides the worker banner when the worker ran a minute ago`
  - `IngestionPanel` test `bulk progress counts come from the reels prop`
  - Delete the `fetchWithAuth` tests together with `api.js`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `grep -rn "API_BASE_URL\|fetchWithAuth\|/health" frontend/src` must return nothing.
- [ ] **Step 4: Run** `npm test` and `npm run lint` → pass.
- [ ] **Step 5: Commit.**

### Task 8: Ship phase A (preview, then production)

**Files:** none (verification and merge)

- [ ] **Step 1: Run the full checks in the worktree:** backend pytest, `npm test`, `npm run lint` → all pass.
- [ ] **Step 2: Stop the old worker** from grabbing new row kinds during preview testing: `schtasks /change /tn InstagramTranscriberQueueDrainer /disable`. The owner runs this. Until Step 6, shares wait in the queue; nothing is lost.
- [ ] **Step 3: Push the branch to get a Vercel preview.** `git push origin feat/supabase-only`; the preview URL appears in Vercel.
- [ ] **Step 4: Check the preview.** After each queued item, run the worker from the worktree root with `C:\Users\jeged\Downloads\Transcriber\backend\.venv\Scripts\python.exe backend\run_worker.py --drain`. Each line must pass:
  - [ ] The sign-in link arrives. Opening it in the **phone's** mail app signs in there (Review Focus 2), and opening it on the PC signs in there.
  - [ ] The library count matches Task 0.
  - [ ] Search returns word, meaning and transcript matches.
  - [ ] Paste text → queued → done after drain, with the title kept.
  - [ ] Upload a short audio file → queued → done; the file is gone from Storage → `audio-uploads`.
  - [ ] Paste a URL → queued → done.
  - [ ] A 2-reel `saved_posts.json` → progress reaches 2/2.
  - [ ] Recompute → "Queued…" → "Clustering…" → done, and clusters refresh.
  - [ ] Retry a failed reel → pending. Delete a test reel → it is gone.
  - [ ] The worker banner appears while the worker hasn't run for more than 15 minutes with an item queued.
  - [ ] Sign out → the login screen; the library is not visible.
- [ ] **Step 5: Merge in the main working copy:** `git merge --no-ff feat/supabase-only`. The scheduled worker now runs the new code. Then `git push origin main`, which deploys Vercel production.
- [ ] **Step 6: Re-enable the scheduled worker:** `schtasks /change /tn InstagramTranscriberQueueDrainer /enable`. Share one reel from the iPhone → it is processed within 5 minutes.
- [ ] **Step 7: Soak.** Use production normally for at least 3 days, including at least one share, one text paste and one recompute, before Task 9. The HF Space stays up as the fallback until Task 10.

### Task 9: Remove anonymous read access

**Files:**
- Modify: `docs/sql/supabase-only.sql` (append)

- [ ] **Step 1: Pre-checks.**
  - The owner is signed in on every device that uses the dashboard.
  - In the iPhone Shortcut's "Get contents of URL" headers, there is **no** `Prefer: return=representation`. Returning the inserted row would need read access and would make the insert fail. If the header is there, ask the owner before editing the Shortcut; this plan doesn't touch it otherwise.
- [ ] **Step 2: Owner says yes, then run:** `drop policy "anon read reels" on public.saved_reels;`
- [ ] **Step 3: Verify.**
  - An anon-key `select id from saved_reels limit 1` returns `[]`.
  - The signed-in dashboard still loads everything.
  - One real iPhone share is inserted and processed.

Rollback: re-create `"anon read reels"` exactly as recorded in `docs/sql/policies-before-supabase-only.md`. It is expected to be `create policy "anon read reels" on public.saved_reels for select to anon using (true);`, but use the recorded `qual` if it differs.

- [ ] **Step 4: Commit** the SQL doc.

### Task 10: Remove the HF backend code and pause the Space

**Files:**
- Modify: `backend/main.py`, `backend/db.py`, `backend/saved_parser.py`, `backend/requirements.txt`, `backend/run_local.ps1`, `backend/test_pipeline.py`
- Delete: `backend/Dockerfile`, `backend/README.md` (the HF Space card)

**Interfaces:**
- Produces: `main.PipelineError(Exception)` with `.status_code: int` and `.detail: str`. It replaces every `HTTPException` in the pipeline. `is_retryable_worker_error` and the 403→`cookies_expired`, 415→`unsupported_format` mapping read it the same way.

- [ ] **Step 1: Delete from `main.py`:**
  - the FastAPI `app`, CORS, `lifespan` and `verify_api_key`
  - `API_AUTH_TOKEN`, `IS_HF_SPACE` and `ExtractionResponse`
  - every `@app` endpoint, `process_reel_url`, `extract_file` and `extract_text`
  - `CLUSTER_JOB`, `_CLUSTER_JOB_LOCK` and `run_cluster_recompute_task`
  - `BATCH_JOB`, `update_batch_job_status`, `ACTIVE_REEL_STATUSES` and `SUCCESS_REEL_STATUSES`

  Delete from `db.py` (only after grepping that nothing uses them): `get_reel_by_url`, `statuses_for_urls`, `insert_pending_reels`. Delete `parse_saved_posts` from `saved_parser.py`; keep `normalize_instagram_url`.
- [ ] **Step 2: Swap the error type.** Replace `HTTPException` with `PipelineError` everywhere in `backend/`, including tests. Delete the endpoint tests and keep every pipeline and worker test.
- [ ] **Step 3: Update setup files.**
  - `requirements.txt`: remove `fastapi`, `uvicorn` and `python-multipart`.
  - `run_local.ps1`: step 7 becomes `& python (Join-Path $PSScriptRoot "run_worker.py")`, and the header comment becomes "set up the venv and run the local worker".
- [ ] **Step 4: Verify.**
  - `...python.exe -m pytest backend` → all pass.
  - `grep -rn "fastapi\|HTTPException\|uvicorn\|SPACE_ID" backend --include=*.py` → nothing.
  - `backend\.venv\Scripts\python.exe backend\run_worker.py --drain` exits cleanly against the real queue.
- [ ] **Step 5: Commit, merge to main, and push.**
- [ ] **Step 6: Pause the HF Space** (the owner, in HF → Space → Settings → **Pause**). Do **not** delete it.

Rollback: unpause the Space and `git revert` this task's commit.

### Task 11: Documentation and configuration cleanup

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`, `README.md`, `.env.example`, `frontend/.env.example`
- Modify: the memory note `hybrid-architecture-direction.md`

- [ ] **Step 1: Docs.**
  - `CLAUDE.md`/`AGENTS.md`: rewrite Architecture, Commands and Deploy for "Supabase + home worker". Remove HF, the endpoints, `API_AUTH_TOKEN`, `ENABLE_WORKER`, `VITE_API_URL`, `VITE_API_KEY` and the subtree push. Document the job kinds, `cluster_jobs`, `worker_status`, the `audio-uploads` bucket and `is_owner()`, and point to `docs/sql/supabase-only.sql`.
  - `README.md`: same changes, plus the new architecture diagram.
- [ ] **Step 2: Env files.** Remove `API_AUTH_TOKEN`, `ENABLE_WORKER`, `VITE_API_URL` and `VITE_API_KEY` from `.env.example` and `frontend/.env.example`. The owner removes `VITE_API_URL` from Vercel's environment variables.
- [ ] **Step 3: Check and commit.** `npm run build` succeeds; then commit, merge and push.
- [ ] **Step 4: Follow-up after 14 quiet days.** Delete the HF Space and run `git remote remove hf`. The owner decides when.
