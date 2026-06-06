# Share-to-App (Hybrid Cloud) — Design

**Date:** 2026-06-06
**Status:** Approved (architecture); decomposed into sub-projects, each needs its own plan
**Depends on / sequenced after:** local bulk-import feature
(`2026-06-06-bulk-import-design.md`) finishing first — user has batch jobs running.

## Problem

While doomscrolling on iPhone, the user saves reels to digest later. They want
to **share a reel from Instagram and have it automatically run through this app's
extraction pipeline**, landing in the dashboard with no manual copy-paste.

## Core constraint that shapes everything

Instagram blocks **datacenter/cloud IPs** hard. Running the yt-dlp download from a
cloud host (HF Spaces, Render) causes frequent 403s even with `cookies.txt`. The
download currently works only because it runs from the user's **residential IP**.

**Therefore: the IG-touching work (download + transcribe) must stay on the user's
machine.** Only storage, the share entrypoint, and the dashboard go to the cloud.
This is the "hybrid" architecture.

## Decisions

| Decision | Choice |
|----------|--------|
| Architecture | Hybrid: local worker does IG work, cloud holds queue + storage + dashboard |
| Cloud storage | Supabase (Postgres) |
| Worker location | Poll loop inside the existing FastAPI backend, run locally |
| Share entrypoint | iPhone Apple Shortcut → **direct Supabase REST insert** (insert-only key + RLS) |
| Dashboard hosting | Vercel, reading Supabase **directly** via supabase-js |
| Bulk import | **Keep both** — local SQLite FastAPI batch ships now; reworked onto the queue during migration |

## Target architecture

```
iPhone: Share reel → Shortcut → Supabase REST insert
                                  row: {url, status:"pending", source:"share"}
        ┌───────────────────────── Supabase (Postgres, free) ─────────────────────────┐
        │  saved_reels table = data store AND queue (status column)                     │
        └──────────────────────────────────────────────────────────────────────────────┘
Local PC (residential IP): FastAPI backend poll loop
        → SELECT pending → process_reel_url (download+transcribe+extract) → UPDATE row done
Vercel (free): React dashboard → supabase-js → reads saved_reels → shows insights
```

No IG request ever originates from a datacenter → the 403 problem is designed out.
Extraction runs whenever the user's PC + backend are on (acceptable: this is an
async digest tool, not real-time).

## Sub-projects (each gets its own spec refinement + plan)

### A. Storage migration: SQLite → Supabase  *(foundation — gates B, C, D)*

- Replace `sqlite3` access in `backend/main.py` with the Supabase client
  (`supabase-py`) or `psycopg`. Affected: `init_local_db`, `save_to_database`,
  the `/reels` query, `/clusters` + `/clusters/recompute`, the URL cache lookup
  in `process_reel_url`.
- Schema (`saved_reels`): keep existing columns (`id, url, title, raw_transcript,
  post_caption, extracted_json (jsonb), created_at, cluster`) and **add**:
  - `status text not null default 'done'` — `pending | processing | done | failed`
  - `source text` — `share | bulk | url | file | text`
  - `error text` — last failure detail
- Existing rows (created locally) import as `status='done'`. A one-time migration
  script copies current `local_storage.db` rows into Supabase.
- Config: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role — local backend only,
  never shipped to the browser or the Shortcut).
- Risk: Postgres vs SQLite SQL differences (the `LIKE` search, JSON handling →
  `jsonb`). The in-memory frontend filtering means the server `LIKE` is mostly
  unused, lowering risk.

### B. Local worker (poll loop in existing backend)  *(depends on A)*

- On backend startup, launch a background thread that every N seconds:
  `SELECT * FROM saved_reels WHERE status='pending' ORDER BY created_at LIMIT 1`
  → set `status='processing'` → `process_reel_url(url)` (already refactored in the
  bulk-import work) → on success update row with results + `status='done'`; on
  failure set `status='failed'`, `error=...`.
- Reuses `process_reel_url`. Same throttle/backoff thinking as `batch_import.py`.
- Single-worker, claim-by-status-update to avoid double-processing. (`process_reel_url`
  already saves to DB; in the Supabase world it should UPDATE the existing pending
  row rather than INSERT a new one — refine during planning.)
- Idempotency: URL cache check still applies (don't reprocess a URL already `done`).

### C. iPhone Apple Shortcut → enqueue  *(depends on A; ~10 min)*

- Shortcut: accepts share-sheet input → extracts the reel URL → "Get Contents of
  URL" POST to `https://<project>.supabase.co/rest/v1/saved_reels` with headers
  `apikey: <insert-only-anon-key>`, `Authorization: Bearer <same>`,
  `Content-Type: application/json`, `Prefer: return=minimal`; body
  `{"url": "<shared url>", "status": "pending", "source": "share"}`.
- Supabase RLS: a policy allowing **INSERT only** for the anon role on
  `saved_reels` (no select/update/delete). The anon key in the Shortcut can then
  only enqueue, never read or wipe data.
- Add to share sheet so it appears under Instagram's Share. Shortcut returns
  immediately (fire-and-forget) — optionally shows a "Saved to Transcriber"
  notification.

### D. Dashboard on Vercel reading Supabase directly  *(depends on A)*

- Frontend currently fetches `/reels`, `/clusters` from local FastAPI. A
  Vercel-hosted frontend cannot reach localhost, so repoint the **read** path to
  Supabase via `supabase-js` (anon key with **select** RLS).
- Recompute-clusters is an LLM call → stays server-side. Two options (decide in
  planning): keep it as a manual local action, or move clustering into the worker.
- Show `status` in the UI: pending/processing reels appear as "queued"/"processing"
  placeholders that fill in once the worker finishes. Frontend can poll Supabase or
  use Supabase Realtime.
- Env: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (select-only).

## Security model (personal, single-user)

- **Service role key** (full access): only on the local PC backend `.env`. Never
  shipped anywhere public.
- **Anon key for Shortcut**: RLS = INSERT-only on `saved_reels`. Worst case if
  leaked: someone can enqueue junk URLs (annoying, not destructive). Optionally add
  a `secret` column the worker checks, or a CHECK constraint that `url` matches an
  instagram.com pattern.
- **Anon key for dashboard**: RLS = SELECT-only. Read access to your insights only;
  acceptable for a personal tool. Tighten later with Supabase Auth if desired.

## Bulk import reconciliation (keep both)

- The local SQLite FastAPI bulk-import feature ships and runs **now** (batch jobs
  in flight). No change to that plan.
- During sub-project A, bulk import is reworked to "insert N `pending` rows into
  Supabase"; the worker (B) drains them. The FastAPI `/extract/batch` endpoint
  becomes redundant once the queue exists and can be retired then — not before.
- The one-time SQLite→Supabase migration script carries over everything the local
  batch run produced, so no work is lost.

## Sequencing

1. **(in progress)** Local bulk-import feature — finish/execute its plan.
2. **A. Supabase migration** — the gate. Nothing cloud works until storage moves.
3. **B. Worker poll loop** — once A lands.
4. **C. Shortcut** and **D. Vercel dashboard** — in parallel after A (B makes them
   actually produce results, but C/D can be built against the schema independently).

## Testing strategy (per sub-project)

- **A:** point tests at a Supabase test project (or a local Postgres); assert
  save/read/cluster round-trips match current SQLite behavior. Keep
  `verify_pipeline.py` green by mocking the DB layer.
- **B:** seed a `pending` row (mocked `process_reel_url`), run one poll tick, assert
  the row flips to `done` with results; a raising `process_reel_url` flips it to
  `failed` with `error` set.
- **C:** manual — share a reel, confirm a `pending` row appears in Supabase; verify
  the anon key cannot SELECT/UPDATE (RLS test).
- **D:** manual — dashboard on Vercel loads reels from Supabase; a `pending` row
  shows a placeholder then fills after the worker runs.

## Open items to resolve during each sub-project's planning

- Supabase client choice: `supabase-py` vs raw `psycopg`.
- Whether clustering moves into the worker or stays a manual local action.
- Dashboard live-update: polling vs Supabase Realtime.
- Whether to add a shared-secret/CHECK constraint on the insert-only path.
