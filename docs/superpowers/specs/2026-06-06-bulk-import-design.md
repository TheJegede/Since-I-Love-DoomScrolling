# Bulk Import of Saved Instagram Reels — Design

**Date:** 2026-06-06
**Status:** Approved

## Problem

User has ~344 saved/bookmarked Instagram reels. They want to feed all of them
through the existing extract pipeline from the frontend with a single upload,
instead of running the `batch_import.py` CLI in a terminal.

The Instagram "Download Your Information" export provides
`your_instagram_activity/saved/saved_posts.json`, where each item carries a
`URL`, `Caption`, and `Title` under `label_values[]`. The saved set mixes
`/reel/` URLs (have audio) and `/p/` photo posts (no audio — dropped).

## Goals

- A frontend "Bulk import" mode: upload `saved_posts.json`, click submit, watch
  progress, done.
- Server-side background job so the browser tab does not need to stay open.
- Resumable and restart-safe progress.
- Reuse the existing single-URL pipeline — no duplicated extraction logic.

## Non-Goals

- Accepting the whole export `.zip` (JSON only; user unzips first).
- Importing photo `/p/` posts (no audio).
- Caption-fallback in the UI (the CLI keeps that flag).
- Multiple concurrent jobs (one at a time).

## Decisions

| Decision | Choice |
|----------|--------|
| Where it runs | Backend background job (survives tab close) |
| Job state | In-memory dict mirrored to `batch_progress.json` (resumable, restart-safe) |
| Upload input | `saved_posts.json` only |

## Architecture

### Backend refactor (no duplication)

1. **`process_reel_url(url) -> dict`** — extract the body of the current
   `extract_url` handler into a plain function: cache-check → `download_and_extract_audio`
   → `transcribe_audio` → `guard_silent_hook` → `extract_structured_json` →
   `save_to_database`, with temp-file cleanup. Returns the saved DB record.
   - `POST /extract/url` becomes a thin wrapper calling `process_reel_url`.
   - The batch loop calls `process_reel_url` directly (in-process, no HTTP loopback).

2. **`parse_saved_posts(data) -> list[{url, caption, title}]`** — shared parser
   that filters to `/reel/` URLs. Both the batch endpoint and the CLI
   `batch_import.py` use it (single source of truth). Today the CLI has its own
   `parse_saved`; it is replaced by an import of this shared function.

### Backend job state

Module-level dict, single job at a time:

```python
BATCH_JOB = {
  "status": "idle" | "running" | "done" | "error",
  "total": int,        # reels queued this run
  "done": int,         # processed this run (ok + failed)
  "ok": int,
  "failed": int,
  "current": str,      # url in flight, or ""
  "errors": [{"url": str, "detail": str}],  # capped (e.g. last 50)
  "started_at": iso8601 | None,
  "finished_at": iso8601 | None,
}
```

`batch_progress.json` (already used by the CLI) remains the per-URL
done/failed ledger keyed by URL. The background loop reads it to skip
already-processed URLs and writes it after each reel, so a backend restart
resumes cleanly. `BATCH_JOB` is the live run summary the frontend polls.

### Endpoints

- **`POST /extract/batch`** — `multipart/form-data` with `file` = `saved_posts.json`.
  - Parse JSON → `parse_saved_posts`. If parse fails → 400.
  - If a job is already `running` → 409.
  - Build queue = reels not already `ok` in `batch_progress.json`.
  - Initialize `BATCH_JOB`, launch background task (FastAPI `BackgroundTasks`
    or `asyncio.create_task`), return `{"started": true, "total": <queue len>}`.
- **`GET /extract/batch/status`** — returns `BATCH_JOB` as-is.

### Background loop

For each reel in the queue:
1. Set `BATCH_JOB["current"] = url`.
2. `process_reel_url(url)` (URL cache makes repeats cheap).
3. On success → `progress[url] = {"status": "ok"}`, `ok += 1`.
   On `HTTPException(400)` (silent hook) → `progress[url] = {"status": "failed", ...}`,
   `failed += 1`. On other error → `failed += 1`, append to `errors`.
4. `done += 1`, persist `batch_progress.json`, `sleep(3)` (throttle Instagram).
On finish set `status = "done"`, `finished_at`. On unexpected fatal error set
`status = "error"`.

### Frontend (`src/App.jsx`)

- Add `'bulk'` to the `mode` toggle (4th tab) alongside `url` / `file` / `text`.
- Bulk panel: a `.json` file input (reuse the existing drop/select pattern from
  file mode) + a submit button.
- Submit → `POST /extract/batch` (FormData). On `{started}` begin polling.
- New state: `batchJob` (status payload), `isBatchPolling`.
- Poll `GET /extract/batch/status` every ~2s while `status === "running"`.
  Render a progress bar: `done/total`, ok/failed counts, current URL.
- On `status === "done"` → stop polling, `fetchReels()` + `fetchClusters()`,
  show summary (ok / failed). On `409` at submit → show "a job is already
  running" and start polling the existing job.

## Data Flow

```
saved_posts.json (browser)
  → POST /extract/batch (multipart)
    → parse_saved_posts → queue (minus already-ok)
    → background loop: process_reel_url per url → save_to_database
       └ updates BATCH_JOB + batch_progress.json
  ← GET /extract/batch/status (polled) → progress bar
  → on done: GET /reels, GET /clusters
```

## Error Handling

- Bad/unparseable JSON → 400 at upload.
- Job already running → 409; frontend attaches to the running job's status.
- Per-reel failures (silent hook, download 403) → counted in `failed` + `errors`,
  loop continues. Re-uploading later retries only not-yet-ok URLs.
- Backend restart mid-job → in-flight `BATCH_JOB` resets to idle on boot; the
  `batch_progress.json` ledger means a re-upload resumes where it stopped.

## Testing

- `verify_pipeline.py` style: mock Groq + `download_and_extract_audio`.
  - `parse_saved_posts` filters `/reel/`, drops `/p/`, pulls url/caption/title.
  - `process_reel_url` returns a record and is hit by `/extract/url` (regression).
  - `POST /extract/batch` with a tiny fixture JSON → 200 `{started, total}`,
    then `GET /extract/batch/status` reaches `done` with expected ok count.
  - Second `POST /extract/batch` while running → 409.

## Shared with CLI

`batch_import.py` (already running against the live DB) and this endpoint share
`batch_progress.json` and the URL cache, so they never double-process. The CLI's
local `parse_saved` is replaced by importing `parse_saved_posts`.
