# Sub-project B: Worker Poll Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background worker to the existing FastAPI backend that drains `status='pending'` rows from the Supabase queue — running download+transcribe+extract on the user's residential IP and writing results back.

**Architecture:** New `db.py` queue functions (`claim_next_pending`, `update_reel_result`, `mark_failed`) plus a worker in `main.py` (`process_pending_reel`, `worker_tick`, `_worker_loop`) started by a FastAPI startup hook, guarded by an `ENABLE_WORKER` env flag. The worker **updates the existing pending row by id** (it does NOT call `process_reel_url`/`save_to_database`, whose URL-cache + insert semantics would mis-handle an already-existing pending row).

**Tech Stack:** FastAPI, threading, `supabase-py`. Tests via `verify_pipeline.py` — DB + pipeline helpers mocked; one worker tick tested directly (no real thread, no Supabase).

---

## Prerequisites

1. **Sub-project A merged** — `db.py` exists with the Supabase data layer; `saved_reels` has `status`/`source`/`error` columns; `main.py` imports `db`.
2. **Pipeline helpers exist** (already in `main.py`): `download_and_extract_audio`, `transcribe_audio`, `guard_silent_hook`, `extract_structured_json`.

## Key design note — why not reuse `process_reel_url`

`process_reel_url` starts with a URL cache check (`db.get_reel_by_url`) and ends with `save_to_database` (INSERT, unique `url`). For a queued reel the row **already exists** as `pending`:
- the cache check would return the pending row and skip processing, and
- `save_to_database` would try to INSERT a duplicate `url` → unique-constraint error.

So the worker uses a dedicated `process_pending_reel(row)` that runs the same pipeline helpers but **UPDATEs the existing row by id**.

---

### Task 1: Queue functions in `db.py`

**Files:**
- Modify: `backend/db.py`
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py` (before `__main__`):

```python
def test_db_queue_surface():
    print("Testing db.py exposes queue functions...")
    import db
    for fn in ("claim_next_pending", "update_reel_result", "mark_failed"):
        assert hasattr(db, fn), f"db.{fn} missing"
    print("[OK] db queue surface passed!")
```

Register in `__main__`:

```python
    test_db_queue_surface()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/verify_pipeline.py`
Expected: FAIL — `AssertionError: db.claim_next_pending missing`.

- [ ] **Step 3: Add the queue functions to `backend/db.py`**

Append to `backend/db.py`:

```python
def claim_next_pending() -> Optional[dict]:
    """Atomically claim the oldest pending reel: flip it to 'processing' and
    return the raw row. Returns None if the queue is empty or another worker
    won the claim. Single-worker safe; the status-guarded update also makes it
    safe enough for occasional overlap."""
    c = get_client()
    res = (c.table(TABLE).select("*")
           .eq("status", "pending").order("created_at").limit(1).execute())
    rows = res.data or []
    if not rows:
        return None
    row = rows[0]
    upd = (c.table(TABLE).update({"status": "processing"})
           .eq("id", row["id"]).eq("status", "pending").execute())
    if not upd.data:
        return None  # lost the race
    return row


def update_reel_result(reel_id: str, title: str, raw_transcript, post_caption,
                       extracted_json, status: str = "done") -> None:
    """Write pipeline results back onto an existing (claimed) row."""
    get_client().table(TABLE).update({
        "title": title,
        "raw_transcript": raw_transcript,
        "post_caption": post_caption,
        "extracted_json": extracted_json,
        "status": status,
        "error": None,
    }).eq("id", reel_id).execute()


def mark_failed(reel_id: str, error) -> None:
    """Mark a claimed row failed, recording a truncated error message."""
    get_client().table(TABLE).update({
        "status": "failed",
        "error": str(error)[:500],
    }).eq("id", reel_id).execute()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: PASS — `[OK] db queue surface passed!`

- [ ] **Step 5: Commit**

```bash
git add backend/db.py backend/verify_pipeline.py
git commit -m "feat(backend): Supabase queue functions (claim/update/mark_failed)"
```

---

### Task 2: Worker in `main.py`

**Files:**
- Modify: `backend/main.py` (add worker functions after `process_reel_url`; add a startup hook)
- Modify: `backend/verify_pipeline.py` (ensure worker stays off during tests; add tick tests)

- [ ] **Step 1: Keep the worker off during tests**

At the very top of `backend/verify_pipeline.py`, right after the existing
`os.environ` GROQ block, add:

```python
# Never spawn the background worker thread during tests
os.environ["ENABLE_WORKER"] = "0"
```

- [ ] **Step 2: Write the failing tests**

Add to `backend/verify_pipeline.py`:

```python
def test_worker_tick_success():
    print("Testing worker_tick processes a pending reel (mocked)...")
    import main
    long_transcript = " ".join(["word"] * 30)
    mocked = ReelExtraction(core_topic="T", key_takeaway="K",
                            action_items=["a"], tools_or_resources=["b"])
    captured = {}
    orig = (main.db.claim_next_pending, main.download_and_extract_audio,
            main.transcribe_audio, main.extract_structured_json,
            main.db.update_reel_result, main.db.mark_failed)
    main.db.claim_next_pending = lambda: {"id": "row1", "url": "https://www.instagram.com/reel/Z/"}
    main.download_and_extract_audio = lambda url: ("/tmp/nope.mp3", "cap", "Title")
    main.transcribe_audio = lambda p: long_transcript
    main.extract_structured_json = lambda t, c: mocked
    main.db.update_reel_result = lambda reel_id, title, raw_transcript, post_caption, extracted_json, status="done": captured.update(
        {"id": reel_id, "status": status, "title": title})
    main.db.mark_failed = lambda reel_id, error: captured.update({"failed": reel_id})
    try:
        did = main.worker_tick()
        assert did is True
        assert captured["id"] == "row1", captured
        assert captured["status"] == "done", captured
        assert "failed" not in captured
        print("[OK] worker_tick success passed!")
    finally:
        (main.db.claim_next_pending, main.download_and_extract_audio,
         main.transcribe_audio, main.extract_structured_json,
         main.db.update_reel_result, main.db.mark_failed) = orig


def test_worker_tick_failure():
    print("Testing worker_tick marks a failed download (mocked)...")
    import main
    from fastapi import HTTPException
    captured = {}
    orig = (main.db.claim_next_pending, main.download_and_extract_audio, main.db.mark_failed)
    main.db.claim_next_pending = lambda: {"id": "row2", "url": "https://www.instagram.com/reel/F/"}
    def _boom(url):
        raise HTTPException(status_code=500, detail="Meta blocking request")
    main.download_and_extract_audio = _boom
    main.db.mark_failed = lambda reel_id, error: captured.update({"id": reel_id, "error": str(error)})
    try:
        did = main.worker_tick()
        assert did is True
        assert captured["id"] == "row2", captured
        assert "Meta blocking" in captured["error"]
        print("[OK] worker_tick failure passed!")
    finally:
        (main.db.claim_next_pending, main.download_and_extract_audio, main.db.mark_failed) = orig


def test_worker_tick_empty():
    print("Testing worker_tick no-op on empty queue...")
    import main
    orig = main.db.claim_next_pending
    main.db.claim_next_pending = lambda: None
    try:
        assert main.worker_tick() is False
        print("[OK] worker_tick empty passed!")
    finally:
        main.db.claim_next_pending = orig
```

Register all three in `__main__`:

```python
    test_worker_tick_success()
    test_worker_tick_failure()
    test_worker_tick_empty()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python backend/verify_pipeline.py`
Expected: FAIL — `AttributeError: module 'main' has no attribute 'worker_tick'`.

- [ ] **Step 4: Implement the worker in `main.py`**

After `process_reel_url` (and its `/extract/url` route), add:

```python
def process_pending_reel(row: dict) -> None:
    """Run the pipeline for one claimed queue row and UPDATE it in place.

    Unlike process_reel_url, this never inserts — the row already exists as
    'processing'. Download failures (e.g. IG 403) mark the row 'failed' so it
    can be retried later by resetting its status to 'pending'.
    """
    reel_id = row["id"]
    url = row["url"]
    mp3_path = None
    try:
        mp3_path, post_caption, title = download_and_extract_audio(url)
        raw_transcript = ""
        try:
            raw_transcript = transcribe_audio(mp3_path)
        except Exception as e:
            logger.warning(f"Transcription failed: {str(e)}. Using caption only.")
        guard_silent_hook(raw_transcript, post_caption)
        extracted = extract_structured_json(raw_transcript, post_caption)
        db.update_reel_result(
            reel_id=reel_id,
            title=title,
            raw_transcript=raw_transcript,
            post_caption=post_caption,
            extracted_json=extracted.model_dump(),
        )
        logger.info(f"Worker processed reel {reel_id} ({url})")
    except HTTPException as e:
        logger.warning(f"Worker failed reel {reel_id}: {e.detail}")
        db.mark_failed(reel_id, e.detail)
    except Exception as e:
        logger.error(f"Worker error on reel {reel_id}: {str(e)}")
        db.mark_failed(reel_id, str(e))
    finally:
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
            except Exception as ce:
                logger.warning(f"Could not delete temp file {mp3_path}: {str(ce)}")


def worker_tick() -> bool:
    """Process at most one pending reel. Returns True if one was claimed."""
    row = db.claim_next_pending()
    if not row:
        return False
    process_pending_reel(row)
    return True


def _worker_loop(poll_interval: float = 5.0, idle_interval: float = 20.0) -> None:
    """Background loop: drain the queue, backing off when it's empty."""
    logger.info("Queue worker started.")
    while True:
        try:
            did_work = worker_tick()
        except Exception as e:
            logger.error(f"Worker tick crashed: {str(e)}")
            did_work = False
        time.sleep(poll_interval if did_work else idle_interval)


@app.on_event("startup")
def _start_worker():
    if os.getenv("ENABLE_WORKER", "1") == "0":
        logger.info("ENABLE_WORKER=0 — queue worker disabled.")
        return
    threading.Thread(target=_worker_loop, daemon=True).start()
```

> `threading` and `time` are already imported (added during the bulk-import work). If not present, add `import threading` and `import time` near the top.

- [ ] **Step 5: Run tests to verify they pass**

Run: `python backend/verify_pipeline.py`
Expected: PASS — `[OK] worker_tick success passed!`, `[OK] worker_tick failure passed!`, `[OK] worker_tick empty passed!`, plus all prior tests.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(backend): background queue worker drains pending reels"
```

---

### Task 3: Manual end-to-end verification

No code — confirm the worker drains a real queued row.

- [ ] **Step 1: Enqueue a pending row**

In the Supabase SQL Editor, insert one pending reel (use a URL from your saved set):

```sql
insert into saved_reels (id, url, extracted_json, status, source)
values (gen_random_uuid()::text, 'https://www.instagram.com/reel/<a-saved-one>/',
        '{}'::jsonb, 'pending', 'share');
```

- [ ] **Step 2: Start the backend (worker on)**

Run: `backend/run_local.ps1`
Expected: logs `Queue worker started.` Within ~5–20s the worker claims the row.

- [ ] **Step 3: Confirm the row processed**

In Supabase, refresh `saved_reels`. The row's `status` should move `pending → processing → done`, with `title`, `raw_transcript`, `extracted_json` populated. (If the download 403s, status becomes `failed` with an `error` — expected only if cookies are stale; this validates the failure path too.)

- [ ] **Step 4: Confirm idle backoff**

With no pending rows, the log should go quiet (no tight loop). `GET /reels` still returns the now-`done` row.

- [ ] **Step 5: Retry a failed row (sanity)**

If a row is `failed`, reset it and watch the worker pick it up again:

```sql
update saved_reels set status='pending', error=null
where status='failed';
```

Expected: worker reclaims and reprocesses.

---

## Self-Review

- **Spec coverage (sub-project B):** background poll loop in existing backend ✓; finds pending → processing → done/failed ✓ (Tasks 1–2); reuses pipeline helpers ✓ (`process_pending_reel`); claim-by-status-update avoids double-processing ✓ (`claim_next_pending`); UPDATE existing row instead of INSERT ✓ (design note + `update_reel_result`); idempotency/retry via status reset ✓ (Task 3 Step 5); worker run locally, off in tests ✓ (`ENABLE_WORKER`).
- **Placeholder scan:** none — full code/commands throughout. `<a-saved-one>` is a deliberate user-supplied URL.
- **Type consistency:** `claim_next_pending() -> row|None`, `update_reel_result(reel_id,title,raw_transcript,post_caption,extracted_json,status='done')`, `mark_failed(reel_id,error)`, `process_pending_reel(row)`, `worker_tick()->bool`, `_worker_loop(poll_interval,idle_interval)` — signatures match across `db.py`, `main.py`, and test mocks. `row` dict carries `id` + `url`, consistent with what `claim_next_pending` returns and `process_pending_reel` consumes.
- **Interaction note:** worker deliberately bypasses `process_reel_url` to avoid the cache-hit / duplicate-insert trap (documented in the design note).
```
