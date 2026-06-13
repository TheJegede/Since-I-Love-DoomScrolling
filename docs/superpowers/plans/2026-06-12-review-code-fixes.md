# Review-Code Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead code, duplication, deprecated APIs, and CORS misconfig found in the codebase review, and split the 1047-line `App.jsx` into focused, test-covered components.

**Architecture:** Three phases run in order. Phase A is backend-only, verified by the existing `verify_pipeline.py` script (new test functions added to it). Phase B stands up a Vitest + React Testing Library harness (none exists today). Phase C does behavior-preserving cleanups and component extraction in `App.jsx` under characterization tests written first (TDD).

**Tech Stack:** Python 3.11 / FastAPI 0.111 / Pydantic 2 (backend, tests via `verify_pipeline.py` script). React 19 / Vite 8 / Vitest 3 / @testing-library/react (frontend).

**Decisions locked in (from review):**
- CORS: keep `allow_origins=["*"]`, set `allow_credentials=False` (app sends no cookies/auth — no login layer needed).
- App.jsx: extract components, TDD via new Vitest harness.
- Backend: apply all findings (quick wins + `_chunked` helper + `_run_pipeline` extraction + lifespan migration + `row_to_record` JSON guard).
- `verify_pipeline.py`: keep the homegrown harness; only add new test functions, keep it green.

**Conventions for this plan:**
- Backend tests live in `backend/verify_pipeline.py`. A "test" = a `def test_*()` function PLUS a call added to the `__main__` block. Run the whole suite with `python backend/verify_pipeline.py`.
- Backend commands assume the venv python. Use `backend/.venv/Scripts/python.exe` on Windows, or `python` if the venv is active.
- Frontend commands run from `frontend/`.
- Commit after every task.

---

## 🟢 HANDOFF STATUS — resume at Task C4 (updated 2026-06-12)

**Done and committed:** Phase A (A1–A8), Phase B (B1–B2), Phase C tasks C1, C2, C3.
**Remaining:** C4, C5, C6, C7, C8, C9. Start at **C4**.

### Working state
- **Branch:** `refactor/review-code-fixes` (off `main`). All work committed here, one commit per task. Do NOT work on `main`.
- **Backend tests:** `backend/.venv/Scripts/python.exe verify_pipeline.py` → must end `--- All tests completed successfully! ---`. Currently green.
- **Frontend (run from `frontend/`):** `npm test` → 2 files, 4 tests passing. `npm run lint` → clean. `npm run build` → builds. Deps already installed (Vitest + RTL).
- **`frontend/src/App.jsx` is currently 963 lines.** Goal after C4–C8: well under 600.

### Commit log so far (newest first)
```
0c9857a refactor(frontend): stabilize queued-reel polling interval        (C3)
361c765 refactor(frontend): collapse ingestion tab buttons into a map     (C2)
e0fda6a refactor(frontend): remove dead fetchClusters no-op + call sites  (C1)
9f376c4 test(frontend): characterization tests for App baseline behavior  (B2)
29e22ca test(frontend): add Vitest + React Testing Library harness        (B1)
c4a15e5 docs(backend): fix duplicate step numbering comment in extract_file (A8)
c95a353 chore(backend): drop unused import, use sys.exit in run_worker     (A7)
e048392 fix(backend): drop allow_credentials with wildcard CORS origin     (A6)
dc52ede fix(backend): guard row_to_record against malformed extracted_json (A5)
a40a98a refactor(backend): migrate startup worker to FastAPI lifespan      (A4)
9b6a0bd refactor(backend): extract shared _run_pipeline from url + worker  (A3)
d131917 refactor(backend): extract _chunked helper, replace 4 chunk loops  (A2)
7773baf refactor(backend): hoist datetime/uuid imports                     (A1)
```

### ⚠️ Deviations from the plan as written (already applied — do not redo)
1. **B1 vite.config:** added `esbuild: { jsx: 'automatic' }` on top of the plan's config. Without it React 19 fails under Vitest with `React is not defined`. It is already in `frontend/vite.config.js`.
2. **B2/C1 App.test.jsx:** uses `globalThis.fetch` (not `global.fetch` as the plan snippet shows). ESLint's `no-undef` rejects bare `global`. Use `globalThis` in any new test that stubs fetch.
3. **C3 polling ref:** the plan put `anyPendingRef.current = …` directly before `return (`. ESLint (`react-hooks` v7) errors `Cannot access refs during render`. It was instead synced inside a dedicated `useEffect(… , [reels])`. The single stable polling interval (`useEffect(…, [])`) is as planned. No action needed.

### ⚠️ Line numbers in C4–C8 below are STALE (pre-refactor)
C1–C3 shifted everything. **Locate code by content/anchor, not by the line numbers printed in the tasks.** Current anchors in `frontend/src/App.jsx`:
- `function Skeleton()` → line 39; `function TableSkeleton()` → line 57 (C4 targets, unchanged by C1–C3).
- `import { supabase, rowToRecord } from './supabaseClient';` → line 3 (where component imports get added).
- `<section className="glass ingestion-panel">` → line 531 (C8 target, runs to its matching `</section>`).
- table branch `) : viewMode === 'table' ? (` → line 793, table `{filteredReels.map(reel => {` → line 802 (C6 target).
- cards-grid branch (final `: (`) `{filteredReels.map((reel) => {` → line 830 (C7 target).
- modal IIFE `{selectedReel && (() => {` → line 893 to end of component (C5 target).
- `ingestionTabs` array already exists in the component (added in C2) — C8 receives it as a prop; do not redefine it.

### Per-task verification (every remaining task)
After each task: run `npm test && npm run lint` from `frontend/`. The 4 baseline tests + each new component test must pass, lint clean. Commit with the message in the task. C8 also runs `npm run build`. C9 is the final full-suite + manual smoke pass.

---

## Phase A — Backend ✅ DONE (A1–A8 all committed)

### Task A1: Hoist module-level imports, kill redundant local imports

**Files:**
- Modify: `backend/main.py`

Currently `datetime`/`timezone` and `uuid` are imported inside functions, including a redundant double-import within `extract_batch`.

- [ ] **Step 1: Add the imports at module top**

In `backend/main.py`, change the top import block (lines 1-13) to add `uuid` and the datetime import. After the edit the relevant lines read:

```python
import os
import json
import time
import uuid
import threading
import tempfile
import logging
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
import yt_dlp
from groq import Groq
from dotenv import load_dotenv
```

- [ ] **Step 2: Remove the local import in `update_batch_job_status`**

Delete the two lines at the end of `update_batch_job_status` (currently lines 777-778):

```python
        from datetime import datetime, timezone
        BATCH_JOB["finished_at"] = datetime.now(timezone.utc).isoformat()
```

so the block becomes:

```python
    if processing == 0:
        BATCH_JOB["status"] = "done"
        BATCH_JOB["finished_at"] = datetime.now(timezone.utc).isoformat()
```

- [ ] **Step 3: Remove the local imports in `extract_batch`**

In `extract_batch`, delete `import uuid` and `from datetime import datetime, timezone` (currently lines 815-816, inside `if new_reels:`) and the second redundant `from datetime import datetime, timezone` (currently line 838). The `if new_reels:` block's first lines become:

```python
    enqueued_count = 0
    if new_reels:
        rows_to_insert = [
            {
                "id": str(uuid.uuid4()),
```

and the batch-tracking block that followed line 838 starts directly with the existing comment:

```python
    # Initialize batch tracking state
    BATCH_JOB.update({
```

- [ ] **Step 4: Run the suite to verify nothing broke**

Run: `python backend/verify_pipeline.py`
Expected: ends with `--- All tests completed successfully! ---`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py
git commit -m "refactor(backend): hoist datetime/uuid imports, drop redundant local re-imports"
```

---

### Task A2: Add a `_chunked` helper and replace the 4 manual chunk loops

**Files:**
- Modify: `backend/main.py`
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add this function to `backend/verify_pipeline.py` (place it just before `test_parse_saved_posts`):

```python
def test_chunked_helper():
    print("Testing _chunked splits sequences into fixed-size lists...")
    from main import _chunked
    assert list(_chunked([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]
    assert list(_chunked([], 3)) == []
    assert list(_chunked([1, 2], 5)) == [[1, 2]]
    print("[OK] _chunked helper passed!")
```

Add its call in the `__main__` block (just before `test_parse_saved_posts()`):

```python
    test_chunked_helper()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/verify_pipeline.py`
Expected: FAIL with `ImportError: cannot import name '_chunked' from 'main'`.

- [ ] **Step 3: Add the helper**

In `backend/main.py`, add this helper immediately after the `CLUSTER_CHUNK_DELAY = 30` line (after line 138), before `_cluster_one_chunk`:

```python
def _chunked(seq: list, size: int):
    """Yield successive `size`-length slices of `seq`."""
    for i in range(0, len(seq), size):
        yield seq[i:i + size]
```

- [ ] **Step 4: Replace the manual loops**

In `update_batch_job_status`, replace (currently lines 732-740):

```python
    db_rows = []
    for i in range(0, len(urls), 100):
        chunk = urls[i:i+100]
        try:
            res = client.table(db.TABLE).select("url", "status", "error").in_("url", chunk).execute()
            db_rows.extend(res.data or [])
        except Exception as e:
            logger.error(f"Error fetching batch status chunk: {e}")
```

with:

```python
    db_rows = []
    for chunk in _chunked(urls, 100):
        try:
            res = client.table(db.TABLE).select("url", "status", "error").in_("url", chunk).execute()
            db_rows.extend(res.data or [])
        except Exception as e:
            logger.error(f"Error fetching batch status chunk: {e}")
```

In `extract_batch`, replace the existing-URL check (currently lines 804-809):

```python
    existing_urls = set()
    for i in range(0, len(urls), 100):
        chunk = urls[i:i+100]
        res = client.table(db.TABLE).select("url").in_("url", chunk).execute()
        for row in (res.data or []):
            existing_urls.add(row["url"])
```

with:

```python
    existing_urls = set()
    for chunk in _chunked(urls, 100):
        res = client.table(db.TABLE).select("url").in_("url", chunk).execute()
        for row in (res.data or []):
            existing_urls.add(row["url"])
```

In `extract_batch`, replace the insert loop (currently lines 832-834):

```python
        # Insert in chunks of 50
        for i in range(0, len(rows_to_insert), 50):
            client.table(db.TABLE).insert(rows_to_insert[i:i+50]).execute()
```

with:

```python
        # Insert in chunks of 50
        for chunk in _chunked(rows_to_insert, 50):
            client.table(db.TABLE).insert(chunk).execute()
```

In `get_reels_status`, replace (currently lines 876-880):

```python
    db_rows = []
    for i in range(0, len(urls), 100):
        chunk = urls[i:i+100]
        res = client.table(db.TABLE).select("url", "status", "error").in_("url", chunk).execute()
        db_rows.extend(res.data or [])
```

with:

```python
    db_rows = []
    for chunk in _chunked(urls, 100):
        res = client.table(db.TABLE).select("url", "status", "error").in_("url", chunk).execute()
        db_rows.extend(res.data or [])
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: `[OK] _chunked helper passed!` appears and the run ends with `--- All tests completed successfully! ---`.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "refactor(backend): extract _chunked helper, replace 4 manual chunk loops"
```

---

### Task A3: Extract shared `_run_pipeline` from the two pipeline paths

**Files:**
- Modify: `backend/main.py`

`process_reel_url` (lines 518-553) and `process_pending_reel` (lines 565-602) duplicate the download→transcribe→guard→extract sequence and the temp-file cleanup. Extract it. Existing tests (`test_extract_url_regression`, `test_worker_tick_success`, `test_worker_tick_failure`) already cover both call sites — they must stay green.

- [ ] **Step 1: Add the helper**

In `backend/main.py`, add this function immediately before `process_reel_url` (before line 518):

```python
def _run_pipeline(url: str) -> tuple[str, str, str, ReelExtraction]:
    """Download → transcribe → silent-hook guard → LLM extract for one reel.

    Owns the temp audio file (always cleaned up). Returns
    (title, raw_transcript, post_caption, extracted). Raises HTTPException(400)
    on silent-hook reels and HTTPException(500) on download/transcription/LLM
    failures. Callers handle persistence."""
    mp3_path = None
    try:
        mp3_path, post_caption, title = download_and_extract_audio(url)
        raw_transcript = ""
        try:
            raw_transcript = transcribe_audio(mp3_path)
        except Exception as e:
            logger.warning(f"Transcription failed: {str(e)}. Proceeding using metadata/caption only.")
        guard_silent_hook(raw_transcript, post_caption)
        extracted = extract_structured_json(raw_transcript, post_caption)
        return title, raw_transcript, post_caption, extracted
    finally:
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
                logger.info(f"Cleaned up temporary audio file: {mp3_path}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {mp3_path}: {str(ce)}")
```

- [ ] **Step 2: Rewrite `process_reel_url` to use it**

Replace the whole `process_reel_url` body (currently lines 518-553) with:

```python
def process_reel_url(url: str) -> dict:
    """Full single-reel pipeline. Returns the saved DB record.

    Returns the cached row if this URL was already processed. Raises
    HTTPException(400) on silent-hook reels (no spoken content). Used by
    /extract/url and (indirectly) the queue worker."""
    cached = db.get_reel_by_url(url)
    if cached:
        logger.info(f"Returning cached record for URL: {url}")
        return cached

    title, raw_transcript, post_caption, extracted = _run_pipeline(url)
    return save_to_database(
        url=url,
        title=title,
        raw_transcript=raw_transcript,
        post_caption=post_caption,
        extracted=extracted,
    )
```

- [ ] **Step 3: Rewrite `process_pending_reel` to use it**

Replace the whole `process_pending_reel` body (currently lines 565-602) with:

```python
def process_pending_reel(row: dict) -> None:
    """Run the pipeline for one claimed queue row and UPDATE it in place.

    Unlike process_reel_url, this never inserts — the row already exists as
    'processing'. Failures (e.g. IG 403) mark the row 'failed' so it can be
    retried by resetting its status to 'pending'."""
    reel_id = row["id"]
    url = row["url"]
    try:
        title, raw_transcript, post_caption, extracted = _run_pipeline(url)
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
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: `[OK] extract_url regression passed!`, `[OK] worker_tick success passed!`, `[OK] worker_tick failure passed!` all appear; run ends with `--- All tests completed successfully! ---`.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py
git commit -m "refactor(backend): extract shared _run_pipeline from url + worker paths"
```

---

### Task A4: Migrate deprecated `@app.on_event("startup")` to a lifespan handler

**Files:**
- Modify: `backend/main.py`

`@app.on_event("startup")` is deprecated in FastAPI. Replace with an `asynccontextmanager` lifespan. `test_health` already exercises app startup with `ENABLE_WORKER=0`.

- [ ] **Step 1: Import `asynccontextmanager`**

In `backend/main.py`, add to the top import block (after `from datetime import datetime, timezone`):

```python
from contextlib import asynccontextmanager
```

- [ ] **Step 2: Define the lifespan before app creation**

In `backend/main.py`, add this immediately before the `app = FastAPI(` call (before line 64). `_worker_loop` is defined later in the module but is only referenced at runtime, so late binding is fine:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("ENABLE_WORKER", "1") == "0":
        logger.info("ENABLE_WORKER=0 — queue worker disabled.")
    else:
        threading.Thread(target=_worker_loop, daemon=True).start()
    yield
```

- [ ] **Step 3: Wire it into the FastAPI constructor**

Change the `app = FastAPI(...)` call (lines 64-68) to:

```python
app = FastAPI(
    title="Instagram Reels Information Extractor API",
    description="Backend service to scrape, transcribe, and extract structured data from Reels",
    version="1.0.0",
    lifespan=lifespan,
)
```

- [ ] **Step 4: Delete the old startup hook**

Remove the `@app.on_event("startup")` block (currently lines 626-631):

```python
@app.on_event("startup")
def _start_worker():
    if os.getenv("ENABLE_WORKER", "1") == "0":
        logger.info("ENABLE_WORKER=0 — queue worker disabled.")
        return
    threading.Thread(target=_worker_loop, daemon=True).start()
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: `[OK] Health check passed!` appears, no `DeprecationWarning` about `on_event`, run ends with `--- All tests completed successfully! ---`.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py
git commit -m "refactor(backend): migrate startup worker to FastAPI lifespan handler"
```

---

### Task A5: Guard `row_to_record` against malformed JSON

**Files:**
- Modify: `backend/db.py`
- Test: `backend/verify_pipeline.py`

`row_to_record` calls `json.loads` with no guard; the JS twin (`rowToRecord`) catches parse errors. Add parity.

- [ ] **Step 1: Write the failing test**

Add this function to `backend/verify_pipeline.py` (just before `test_db_module_surface`):

```python
def test_row_to_record_handles_bad_json():
    print("Testing row_to_record tolerates malformed extracted_json...")
    import db
    rec = db.row_to_record({"id": "1", "extracted_json": "{not valid json"})
    assert rec["extracted_json"] == {}, rec
    rec2 = db.row_to_record({"id": "2", "extracted_json": '{"core_topic": "x"}'})
    assert rec2["extracted_json"]["core_topic"] == "x", rec2
    print("[OK] row_to_record bad-json guard passed!")
```

Add its call in the `__main__` block (just before `test_db_module_surface()`):

```python
    test_row_to_record_handles_bad_json()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/verify_pipeline.py`
Expected: FAIL with a `json.decoder.JSONDecodeError` raised from `row_to_record`.

- [ ] **Step 3: Add the guard**

In `backend/db.py`, change `row_to_record` (lines 34-36) from:

```python
    ej = r.get("extracted_json")
    if isinstance(ej, str):
        ej = json.loads(ej)
```

to:

```python
    ej = r.get("extracted_json")
    if isinstance(ej, str):
        try:
            ej = json.loads(ej)
        except (json.JSONDecodeError, TypeError):
            ej = {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: `[OK] row_to_record bad-json guard passed!`, run ends with `--- All tests completed successfully! ---`.

- [ ] **Step 5: Commit**

```bash
git add backend/db.py backend/verify_pipeline.py
git commit -m "fix(backend): guard row_to_record against malformed extracted_json"
```

---

### Task A6: Fix CORS credentials misconfig

**Files:**
- Modify: `backend/main.py`
- Test: `backend/verify_pipeline.py`

`allow_origins=["*"]` + `allow_credentials=True` is an invalid combination (browsers reject credentialed cross-origin requests against a wildcard). The app sends no credentials, so set it `False`.

- [ ] **Step 1: Write the failing test**

Add this function to `backend/verify_pipeline.py` (just before `test_health` is fine; place it after `client = TestClient(app)` / before the `__main__` block — put it right before `test_parse_saved_posts`):

```python
def test_cors_no_credentials():
    print("Testing CORS does not advertise credentials with wildcard origin...")
    r = client.options(
        "/health",
        headers={
            "Origin": "https://reels-transcriber.vercel.app",
            "Access-Control-Request-Method": "GET",
        },
    )
    # With allow_credentials=False, Starlette must NOT emit this header as true.
    assert r.headers.get("access-control-allow-credentials") != "true", dict(r.headers)
    print("[OK] CORS no-credentials passed!")
```

Add its call in the `__main__` block (just before `test_parse_saved_posts()`):

```python
    test_cors_no_credentials()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/verify_pipeline.py`
Expected: FAIL — `access-control-allow-credentials` is currently `"true"`.

- [ ] **Step 3: Apply the fix**

In `backend/main.py`, change the CORS middleware block (lines 71-77) so `allow_credentials` is `False`:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: `[OK] CORS no-credentials passed!`, run ends with `--- All tests completed successfully! ---`.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "fix(backend): drop allow_credentials with wildcard CORS origin"
```

---

### Task A7: Clean up `run_worker.py` (unused import, `sys.exit`)

**Files:**
- Modify: `backend/run_worker.py`

- [ ] **Step 1: Remove the unused `import db`**

In `backend/run_worker.py`, delete line 17:

```python
import db
```

(The worker uses `main.db` internally; `run_worker.py` never references `db` directly.)

- [ ] **Step 2: Use `sys.exit` instead of builtin `exit`**

Change line 24 from:

```python
        exit(1)
```

to:

```python
        sys.exit(1)
```

- [ ] **Step 3: Smoke-test the import path**

Run: `python -c "import ast,sys; ast.parse(open('backend/run_worker.py').read()); print('parse ok')"`
Expected: `parse ok`.

Then verify the module imports cleanly without DB creds (it should reach the env check and exit 1):

Run: `python backend/run_worker.py`
Expected (when SUPABASE creds are NOT set): logs `SUPABASE_URL / SUPABASE_SERVICE_KEY env vars not set. Exiting.` and exits. If creds ARE set, it starts looping — `Ctrl+C` to stop; that is also success.

- [ ] **Step 4: Commit**

```bash
git add backend/run_worker.py
git commit -m "chore(backend): drop unused import, use sys.exit in run_worker"
```

---

### Task A8: Low-severity comment/logging cleanup

**Files:**
- Modify: `backend/main.py`

- [ ] **Step 1: Fix duplicate step numbering in `extract_file`**

In `extract_file`, the comments number two different steps "3." Change the second one (currently line 666) from:

```python
        # 3. Commit to Database
```

to:

```python
        # 4. Commit to Database
```

- [ ] **Step 2: Run the suite**

Run: `python backend/verify_pipeline.py`
Expected: ends with `--- All tests completed successfully! ---`.

- [ ] **Step 3: Commit**

```bash
git add backend/main.py
git commit -m "docs(backend): fix duplicate step numbering comment in extract_file"
```

---

## Phase B — Frontend Test Harness ✅ DONE (B1–B2 committed; see Deviations 1 & 2 in Handoff Status)

### Task B1: Stand up Vitest + React Testing Library

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.js`
- Create: `frontend/src/test/setup.js`
- Create: `frontend/src/test/smoke.test.jsx`

- [ ] **Step 1: Install dev dependencies**

Run (from `frontend/`):

```bash
npm install -D vitest@^3 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14
```

- [ ] **Step 2: Add test scripts to package.json**

In `frontend/package.json`, change the `scripts` block to:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 3: Configure Vitest in vite.config.js**

Replace the contents of `frontend/vite.config.js` with:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
})
```

- [ ] **Step 4: Create the test setup file**

Create `frontend/src/test/setup.js`:

```js
import '@testing-library/jest-dom';
```

- [ ] **Step 5: Write a smoke test**

Create `frontend/src/test/smoke.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

function Hello() {
  return <h1>hello test harness</h1>;
}

describe('test harness', () => {
  it('renders a component', () => {
    render(<Hello />);
    expect(screen.getByText('hello test harness')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the test to verify the harness works**

Run (from `frontend/`): `npm test`
Expected: 1 test file, 1 passed.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.js frontend/src/test/setup.js frontend/src/test/smoke.test.jsx
git commit -m "test(frontend): add Vitest + React Testing Library harness"
```

---

### Task B2: Characterization test for App (baseline before any refactor)

**Files:**
- Create: `frontend/src/test/App.test.jsx`

This locks in current behavior so the Phase C cleanups and extractions are provably behavior-preserving. `App.jsx` imports `supabase`/`rowToRecord` from `./supabaseClient` and uses global `fetch` — both are mocked.

- [ ] **Step 1: Write the characterization tests**

Create `frontend/src/test/App.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// supabase null => App falls back to fetch('/reels'); we mock fetch instead.
vi.mock('../supabaseClient', () => ({
  supabase: null,
  rowToRecord: (r) => r,
}));

import App from '../App';

beforeEach(() => {
  vi.restoreAllMocks();
  // /health ok, /reels empty by default
  global.fetch = vi.fn((input) => {
    const u = String(input);
    if (u.endsWith('/health')) return Promise.resolve({ ok: true });
    if (u.includes('/reels')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
});

describe('App baseline', () => {
  it('renders the header', () => {
    render(<App />);
    expect(screen.getByText('Transcriber')).toBeInTheDocument();
  });

  it('renders the four ingestion mode tabs', () => {
    render(<App />);
    expect(screen.getByText('Reel URL')).toBeInTheDocument();
    expect(screen.getByText('Audio File')).toBeInTheDocument();
    expect(screen.getByText('Transcript Text')).toBeInTheDocument();
    expect(screen.getByText('Bulk Import')).toBeInTheDocument();
  });

  it('shows the empty state once fetch resolves with no reels', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/No extractions found/i)).toBeInTheDocument()
    );
  });
});
```

- [ ] **Step 2: Run to verify it passes against current App.jsx**

Run (from `frontend/`): `npm test`
Expected: all tests pass (smoke + 3 App baseline tests). If the empty-state test flakes on timing, it is still expected to pass via `waitFor`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/test/App.test.jsx
git commit -m "test(frontend): characterization tests for App baseline behavior"
```

---

## Phase C — App.jsx Cleanups & Component Extraction

> Every task in this phase ends by running `npm test` (the Phase B suite must stay green) and, where noted, `npm run lint`. The App baseline tests are the safety net for behavior preservation.

### Task C1: Delete the dead `fetchClusters` no-op ✅ DONE

**Files:**
- Modify: `frontend/src/App.jsx`

`fetchClusters` (lines 181-184) does nothing; clusters are derived in `fetchReels` via `computeClusters`. Remove it and its three call sites.

- [ ] **Step 1: Remove the function definition**

Delete lines 181-184:

```jsx
  const fetchClusters = async () => {
    // Clusters are derived from the loaded reels (see fetchReels/computeClusters).
    // Kept as a callable so existing call sites (e.g. after recompute) still work.
  };
```

- [ ] **Step 2: Remove the mount call**

In the mount `useEffect` (lines 187-192), delete the `fetchClusters();` line so it reads:

```jsx
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchReels();
    checkBackendHealth();
  }, []);
```

- [ ] **Step 3: Remove the call in `handleRecompute`**

In `handleRecompute` (lines 211-212), delete `await fetchClusters();` so it reads:

```jsx
      await fetchReels();
```

- [ ] **Step 4: Remove the call in `pollBatchStatus`**

In `pollBatchStatus` (lines 399-400), delete `fetchClusters();` so it reads:

```jsx
        setIsBatchRunning(false);
        fetchReels();
```

- [ ] **Step 5: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: all tests pass; lint reports no new errors (no `fetchClusters is not defined`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "refactor(frontend): remove dead fetchClusters no-op and its call sites"
```

---

### Task C2: Collapse the 4 near-identical ingestion tab buttons into a `.map` ✅ DONE

**Files:**
- Modify: `frontend/src/App.jsx`

The four mode buttons (lines 526-553) differ only by mode key, icon, and label.

- [ ] **Step 1: Add a tab config array**

In `App.jsx`, add this constant inside the component, right after the `steps` array (after line 138):

```jsx
  const ingestionTabs = [
    { key: 'url', label: 'Reel URL', Icon: Link },
    { key: 'file', label: 'Audio File', Icon: FileAudio },
    { key: 'text', label: 'Transcript Text', Icon: FileText },
    { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
  ];
```

- [ ] **Step 2: Replace the four buttons with a map**

Replace the four `<button className={`alt-input-btn ...`}>` blocks (lines 526-553) with:

```jsx
          {ingestionTabs.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`alt-input-btn ${mode === key ? 'active' : ''}`}
              onClick={() => setMode(key)}
              style={{
                borderBottom: mode === key ? '2px solid var(--accent-primary)' : 'none',
                paddingBottom: '0.5rem',
                color: mode === key ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
```

- [ ] **Step 3: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: the "renders the four ingestion mode tabs" test still passes; lint clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "refactor(frontend): collapse ingestion tab buttons into a map"
```

---

### Task C3: Fix the polling effect that rebuilds its interval on every reels change ✅ DONE (see Deviation 3)

**Files:**
- Modify: `frontend/src/App.jsx`

The effect (lines 195-200) depends on `reels`, so it tears down and recreates the interval on every reels mutation. Use a ref-checked interval that depends only on whether anything is pending, keeping a single stable interval while work is in flight.

- [ ] **Step 1: Add a ref to track pending state**

Add a ref alongside the other refs (after line 103, near `fileInputRef`):

```jsx
  const anyPendingRef = useRef(false);
```

- [ ] **Step 2: Keep the ref in sync each render**

Add this line right before the `return (` of the component (just before line 489):

```jsx
  anyPendingRef.current = reels.some(r => r.status && r.status !== 'done' && r.status !== 'failed');
```

- [ ] **Step 3: Replace the polling effect**

Replace the effect (lines 194-200):

```jsx
  // While any reel is queued/processing, poll so it fills in once the worker finishes.
  useEffect(() => {
    const anyPending = reels.some(r => r.status && r.status !== 'done' && r.status !== 'failed');
    if (!anyPending) return;
    const id = setInterval(fetchReels, 5000);
    return () => clearInterval(id);
  }, [reels]);
```

with:

```jsx
  // While any reel is queued/processing, poll so it fills in once the worker finishes.
  // A single stable interval reads the latest pending state from a ref each tick.
  useEffect(() => {
    const id = setInterval(() => {
      if (anyPendingRef.current) fetchReels();
    }, 5000);
    return () => clearInterval(id);
  }, []);
```

- [ ] **Step 4: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: all tests pass; lint clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "refactor(frontend): stabilize queued-reel polling interval"
```

---

### Task C4: Extract the skeleton components

**Files:**
- Create: `frontend/src/components/Skeletons.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `frontend/src/test/Skeletons.test.jsx`

`Skeleton` (lines 39-55) and `TableSkeleton` (lines 57-86) are already standalone functions with no props — move them out first as the simplest extraction.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/Skeletons.test.jsx`:

```jsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, TableSkeleton } from '../components/Skeletons';

describe('Skeletons', () => {
  it('Skeleton renders a shimmer card', () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelector('.skeleton-card')).toBeTruthy();
  });

  it('TableSkeleton renders 5 placeholder rows', () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll('.skeleton-row').length).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test`
Expected: FAIL — cannot resolve `../components/Skeletons`.

- [ ] **Step 3: Create the component file**

Create `frontend/src/components/Skeletons.jsx` with the two functions moved verbatim from `App.jsx` lines 39-86, exported:

```jsx
export function Skeleton() {
  return (
    <div className="glass reel-card skeleton-card">
      <div className="skeleton-header">
        <div className="skeleton-avatar shimmer"></div>
        <div className="skeleton-badge shimmer"></div>
      </div>
      <div className="skeleton-title shimmer"></div>
      <div className="skeleton-text shimmer"></div>
      <div className="skeleton-text short shimmer"></div>
      <div className="skeleton-footer">
        <div className="skeleton-line shimmer" style={{ width: '60px' }}></div>
        <div className="skeleton-line shimmer" style={{ width: '80px' }}></div>
      </div>
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div className="table-scroll">
      <table className="insights-table glass skeleton-table">
        <thead>
          <tr>
            <th>Topic</th><th>Cluster</th><th>Key takeaway</th><th>Tools</th><th>Saved</th><th></th>
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4, 5].map(i => (
            <tr key={i} className="skeleton-row">
              <td><div className="skeleton-line shimmer" style={{ width: '120px', height: '16px' }}></div></td>
              <td><div className="skeleton-badge shimmer" style={{ width: '80px' }}></div></td>
              <td><div className="skeleton-line shimmer" style={{ width: '90%', height: '14px' }}></div></td>
              <td>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <div className="skeleton-line shimmer" style={{ width: '50px', height: '18px', borderRadius: '4px' }}></div>
                  <div className="skeleton-line shimmer" style={{ width: '65px', height: '18px', borderRadius: '4px' }}></div>
                </div>
              </td>
              <td><div className="skeleton-line shimmer" style={{ width: '75px', height: '14px' }}></div></td>
              <td><div className="skeleton-line shimmer" style={{ width: '20px', height: '20px', borderRadius: '4px' }}></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Remove the functions from App.jsx and import them**

In `App.jsx`, delete the `Skeleton` and `TableSkeleton` function definitions (lines 39-86). Add to the import block at the top of `App.jsx` (after the `./supabaseClient` import on line 3):

```jsx
import { Skeleton, TableSkeleton } from './components/Skeletons';
```

- [ ] **Step 5: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: Skeletons tests pass, App baseline tests still pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Skeletons.jsx frontend/src/App.jsx frontend/src/test/Skeletons.test.jsx
git commit -m "refactor(frontend): extract Skeleton + TableSkeleton components"
```

---

### Task C5: Extract the reel detail modal

**Files:**
- Create: `frontend/src/components/ReelModal.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `frontend/src/test/ReelModal.test.jsx`

The modal (lines 899-1044) is a self-contained block. It reads `selectedReel`, `isTranscriptOpen`, `isCaptionOpen`, `checkedActions`, `copiedText` and calls `setSelectedReel`, `setIsTranscriptOpen`, `setIsCaptionOpen`, `toggleCheckAction`, `handleCopy`, `handleDelete`, `formatDate`. Pass these as props.

**Prop interface for `ReelModal`:**
`reel`, `onClose`, `formatDate`, `isTranscriptOpen`, `setIsTranscriptOpen`, `isCaptionOpen`, `setIsCaptionOpen`, `checkedActions`, `toggleCheckAction`, `copiedText`, `handleCopy`, `handleDelete`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/ReelModal.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReelModal from '../components/ReelModal';

const reel = {
  id: 'r1',
  title: 'My Reel',
  created_at: '2026-06-06T00:00:00Z',
  extracted_json: {
    core_topic: 'AI Tools',
    key_takeaway: 'Automate everything',
    action_items: ['Step one'],
    tools_or_resources: ['Groq'],
  },
};

const noop = () => {};

function renderModal(overrides = {}) {
  return render(
    <ReelModal
      reel={reel}
      onClose={noop}
      formatDate={() => 'Jun 6, 2026'}
      isTranscriptOpen={false}
      setIsTranscriptOpen={noop}
      isCaptionOpen={false}
      setIsCaptionOpen={noop}
      checkedActions={{}}
      toggleCheckAction={noop}
      copiedText={null}
      handleCopy={noop}
      handleDelete={noop}
      {...overrides}
    />
  );
}

describe('ReelModal', () => {
  it('renders title, takeaway, action items and tools', () => {
    renderModal();
    expect(screen.getByText('My Reel')).toBeInTheDocument();
    expect(screen.getByText('Automate everything')).toBeInTheDocument();
    expect(screen.getByText('Step one')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('calls onClose when the overlay is clicked', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    fireEvent.click(container.querySelector('.modal-overlay'));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test`
Expected: FAIL — cannot resolve `../components/ReelModal`.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/ReelModal.jsx`. Move the JSX from `App.jsx` lines 900-1044 (the body of the `selectedReel && (() => { ... })()` IIFE) verbatim into this component, with these substitutions: `selectedReel` → `reel`; `setSelectedReel(null)` → `onClose()`; keep all other names as incoming props.

```jsx
import {
  X, ExternalLink, Trash2, Copy, Check, FileAudio, Info, ChevronUp, ChevronDown,
} from 'lucide-react';

export default function ReelModal({
  reel,
  onClose,
  formatDate,
  isTranscriptOpen,
  setIsTranscriptOpen,
  isCaptionOpen,
  setIsCaptionOpen,
  checkedActions,
  toggleCheckAction,
  copiedText,
  handleCopy,
  handleDelete,
}) {
  const details = reel.extracted_json || {};
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <X size={24} />
        </button>

        <div className="modal-header-meta">
          <span className="card-topic-badge" style={{ fontSize: '0.8rem', padding: '0.35rem 0.85rem' }}>
            {details.core_topic}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Processed on {formatDate(reel.created_at)}
          </span>
          {reel.url && (
            <a
              href={reel.url}
              target="_blank"
              rel="noreferrer"
              className="alt-input-btn"
              style={{ fontSize: '0.85rem' }}
            >
              View Original <ExternalLink size={14} />
            </a>
          )}
          <button
            className="alt-input-btn delete-btn"
            style={{ fontSize: '0.85rem' }}
            onClick={(e) => handleDelete(reel.id, e)}
          >
            Delete <Trash2 size={14} />
          </button>
        </div>

        <h2 className="modal-title">{reel.title || "Extracted Insights"}</h2>

        <div className="modal-section">
          <div className="takeaway-banner">
            <span style={{ fontWeight: '700', color: 'var(--accent-primary)', display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', textTransform: 'uppercase' }}>
              Core Key Takeaway
            </span>
            {details.key_takeaway}
          </div>
        </div>

        {details.action_items && details.action_items.length > 0 && (
          <div className="modal-section">
            <h3 className="modal-section-title">Action Plan / Steps</h3>
            <div className="action-items-list">
              {details.action_items.map((item, index) => {
                const checkKey = `${reel.id}-${index}`;
                return (
                  <div key={index} className="action-item">
                    <input
                      type="checkbox"
                      className="action-checkbox"
                      checked={!!checkedActions[checkKey]}
                      onChange={() => toggleCheckAction(reel.id, index)}
                    />
                    <span className="action-text">{item}</span>
                    <button
                      onClick={() => handleCopy(item, `action-${index}`)}
                      style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                    >
                      {copiedText === `action-${index}` ? <Check size={14} style={{ color: 'var(--accent-success)' }} /> : <Copy size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {details.tools_or_resources && details.tools_or_resources.length > 0 && (
          <div className="modal-section">
            <h3 className="modal-section-title">Referenced Tools & Resources</h3>
            <div className="tools-container">
              {details.tools_or_resources.map((tool, idx) => (
                <div key={idx} className="tool-tag">
                  <span>{tool}</span>
                  <button
                    onClick={() => handleCopy(tool, `tool-${idx}`)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
                  >
                    {copiedText === `tool-${idx}` ? <Check size={12} style={{ color: 'var(--accent-success)' }} /> : <Copy size={12} className="tool-copy-icon" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {reel.raw_transcript && (
          <div className="modal-section" style={{ marginBottom: '1rem' }}>
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsTranscriptOpen(!isTranscriptOpen)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><FileAudio size={16} /> Voice Transcript</span>
                {isTranscriptOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {isTranscriptOpen && (
                <div className="accordion-content">{reel.raw_transcript}</div>
              )}
            </div>
          </div>
        )}

        {reel.post_caption && (
          <div className="modal-section" style={{ marginBottom: '0' }}>
            <div className="transcript-accordion">
              <button className="accordion-trigger" onClick={() => setIsCaptionOpen(!isCaptionOpen)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Info size={16} /> Post Caption / Metadata</span>
                {isCaptionOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {isCaptionOpen && (
                <div className="accordion-content">{reel.post_caption}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into App.jsx**

In `App.jsx`, add the import (after the Skeletons import added in Task C4):

```jsx
import ReelModal from './components/ReelModal';
```

Replace the entire modal IIFE block (lines 899-1044) with:

```jsx
      {selectedReel && (
        <ReelModal
          reel={selectedReel}
          onClose={() => setSelectedReel(null)}
          formatDate={formatDate}
          isTranscriptOpen={isTranscriptOpen}
          setIsTranscriptOpen={setIsTranscriptOpen}
          isCaptionOpen={isCaptionOpen}
          setIsCaptionOpen={setIsCaptionOpen}
          checkedActions={checkedActions}
          toggleCheckAction={toggleCheckAction}
          copiedText={copiedText}
          handleCopy={handleCopy}
          handleDelete={handleDelete}
        />
      )}
```

Remove now-unused icon imports from `App.jsx`'s lucide import only if they are no longer referenced anywhere else in `App.jsx`. Check each of `ExternalLink`, `Copy`, `Check`, `Info`, `ChevronUp`, `ChevronDown` against the remaining `App.jsx` body before deleting — `lint` in the next step will flag any that are now unused.

- [ ] **Step 5: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: ReelModal tests pass, App baseline tests pass. Fix any "unused import" lint errors by removing the now-dead icon imports from `App.jsx`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ReelModal.jsx frontend/src/App.jsx frontend/src/test/ReelModal.test.jsx
git commit -m "refactor(frontend): extract ReelModal component"
```

---

### Task C6: Extract the insights table

**Files:**
- Create: `frontend/src/components/InsightsTable.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `frontend/src/test/InsightsTable.test.jsx`

The table (lines 801-834) renders `filteredReels` and calls `setSelectedReel`, `setIsTranscriptOpen`, `setIsCaptionOpen`, `formatDate`, `handleDelete`.

**Prop interface for `InsightsTable`:** `reels`, `onSelect`, `formatDate`, `handleDelete`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/InsightsTable.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InsightsTable from '../components/InsightsTable';

const reels = [
  {
    id: 'r1',
    title: 'Fallback Title',
    cluster: 'AI Tools',
    created_at: '2026-06-06T00:00:00Z',
    extracted_json: { core_topic: 'Topic A', key_takeaway: 'Takeaway A', tools_or_resources: ['Groq'] },
  },
];

describe('InsightsTable', () => {
  it('renders a row per reel with topic, cluster and tools', () => {
    render(<InsightsTable reels={reels} onSelect={() => {}} formatDate={() => 'Jun 6'} handleDelete={() => {}} />);
    expect(screen.getByText('Topic A')).toBeInTheDocument();
    expect(screen.getByText('AI Tools')).toBeInTheDocument();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('calls onSelect when a row is clicked', () => {
    const onSelect = vi.fn();
    render(<InsightsTable reels={reels} onSelect={onSelect} formatDate={() => 'Jun 6'} handleDelete={() => {}} />);
    fireEvent.click(screen.getByText('Topic A'));
    expect(onSelect).toHaveBeenCalledWith(reels[0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test`
Expected: FAIL — cannot resolve `../components/InsightsTable`.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/InsightsTable.jsx`:

```jsx
import { Trash2 } from 'lucide-react';

export default function InsightsTable({ reels, onSelect, formatDate, handleDelete }) {
  return (
    <div className="table-scroll">
      <table className="insights-table glass">
        <thead>
          <tr>
            <th>Topic</th><th>Cluster</th><th>Key takeaway</th><th>Tools</th><th>Saved</th><th></th>
          </tr>
        </thead>
        <tbody>
          {reels.map(reel => {
            const ej = reel.extracted_json || {};
            return (
              <tr key={reel.id} onClick={() => onSelect(reel)}>
                <td>{ej.core_topic || reel.title}</td>
                <td><span className="cluster-pill">{reel.cluster || 'Unclustered'}</span></td>
                <td>{ej.key_takeaway}</td>
                <td>{(ej.tools_or_resources || []).map((t, i) => (
                  <span className="tool-chip" key={i}>{t}</span>
                ))}</td>
                <td>{formatDate(reel.created_at) || '—'}</td>
                <td>
                  <button className="delete-btn" title="Delete reel" onClick={(e) => handleDelete(reel.id, e)}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into App.jsx**

Add the import (after the ReelModal import):

```jsx
import InsightsTable from './components/InsightsTable';
```

Replace the table branch (lines 800-834, the `) : viewMode === 'table' ? ( ... )` block content — i.e. everything between `viewMode === 'table' ? (` and the closing `)` before `: (`) with:

```jsx
        ) : viewMode === 'table' ? (
          <InsightsTable
            reels={filteredReels}
            onSelect={(reel) => { setSelectedReel(reel); setIsTranscriptOpen(false); setIsCaptionOpen(false); }}
            formatDate={formatDate}
            handleDelete={handleDelete}
          />
```

- [ ] **Step 5: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: InsightsTable tests pass, App baseline tests pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/InsightsTable.jsx frontend/src/App.jsx frontend/src/test/InsightsTable.test.jsx
git commit -m "refactor(frontend): extract InsightsTable component"
```

---

### Task C7: Extract the reel card and cards grid

**Files:**
- Create: `frontend/src/components/ReelCard.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `frontend/src/test/ReelCard.test.jsx`

The cards grid (lines 835-896) renders two card shapes: a placeholder for non-`done` reels and the full card. Extract a single `ReelCard` that handles both.

**Prop interface for `ReelCard`:** `reel`, `onSelect`, `formatDate`, `handleDelete`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/ReelCard.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReelCard from '../components/ReelCard';

const doneReel = {
  id: 'r1',
  title: 'Done Reel',
  status: 'done',
  created_at: '2026-06-06T00:00:00Z',
  extracted_json: { core_topic: 'Topic', key_takeaway: 'Takeaway', action_items: ['a', 'b'] },
};

const pendingReel = { id: 'r2', title: 'Queued Reel', status: 'processing', url: 'https://x/reel/1/' };

describe('ReelCard', () => {
  it('renders a full card for done reels and fires onSelect', () => {
    const onSelect = vi.fn();
    render(<ReelCard reel={doneReel} onSelect={onSelect} formatDate={() => 'Jun 6'} handleDelete={() => {}} />);
    expect(screen.getByText('Done Reel')).toBeInTheDocument();
    expect(screen.getByText('2 tasks')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Done Reel'));
    expect(onSelect).toHaveBeenCalledWith(doneReel);
  });

  it('renders a status placeholder for non-done reels', () => {
    render(<ReelCard reel={pendingReel} onSelect={() => {}} formatDate={() => ''} handleDelete={() => {}} />);
    expect(screen.getByText('Processing…')).toBeInTheDocument();
    expect(screen.getByText('Queued Reel')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test`
Expected: FAIL — cannot resolve `../components/ReelCard`.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/ReelCard.jsx`:

```jsx
import { Trash2, Clock, ArrowRight } from 'lucide-react';

export default function ReelCard({ reel, onSelect, formatDate, handleDelete }) {
  const details = reel.extracted_json || {};

  if (reel.status && reel.status !== 'done') {
    return (
      <article className="glass reel-card" style={{ opacity: 0.7 }}>
        <div className="card-header">
          <span className="card-topic-badge">
            {reel.status === 'processing' ? 'Processing…' : reel.status === 'failed' ? 'Failed' : 'Queued'}
          </span>
          <button className="delete-btn" title="Delete reel" onClick={(e) => handleDelete(reel.id, e)}>
            <Trash2 size={15} />
          </button>
        </div>
        <h3 className="card-title">{reel.title || 'Queued reel'}</h3>
        {reel.url && (
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>{reel.url}</p>
        )}
      </article>
    );
  }

  return (
    <article className="glass glass-interactive reel-card" onClick={() => onSelect(reel)}>
      <div className="card-header">
        <span className="card-topic-badge">{details.core_topic || 'Reel Extract'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="card-date">{formatDate(reel.created_at)}</span>
          <button className="delete-btn" title="Delete reel" onClick={(e) => handleDelete(reel.id, e)}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <h3 className="card-title">{reel.title || 'Untitled Extraction'}</h3>
      <p className="card-takeaway">{details.key_takeaway}</p>

      <div className="card-footer">
        <div className="stat-item">
          <Clock size={14} />
          <span>{details.action_items?.length || 0} tasks</span>
        </div>
        <span className="read-more-link">
          View details <ArrowRight size={14} />
        </span>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Wire it into App.jsx**

Add the import (after the InsightsTable import):

```jsx
import ReelCard from './components/ReelCard';
```

Replace the cards-grid branch (lines 835-896, the final `: (` ... `)` block) with:

```jsx
        ) : (
          <div className="reels-grid">
            {filteredReels.map((reel) => (
              <ReelCard
                key={reel.id}
                reel={reel}
                onSelect={(r) => { setSelectedReel(r); setIsTranscriptOpen(false); setIsCaptionOpen(false); }}
                formatDate={formatDate}
                handleDelete={handleDelete}
              />
            ))}
          </div>
        )}
```

Remove now-unused icon imports from `App.jsx` (e.g. `Clock`, `ArrowRight` if no longer referenced — `ArrowRight` is still used in the URL form button, so keep it; `Clock` is likely now unused). Let `npm run lint` in the next step confirm.

- [ ] **Step 5: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: ReelCard tests pass, App baseline tests pass. Remove any icon import flagged unused.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ReelCard.jsx frontend/src/App.jsx frontend/src/test/ReelCard.test.jsx
git commit -m "refactor(frontend): extract ReelCard component"
```

---

### Task C8: Extract the ingestion panel

**Files:**
- Create: `frontend/src/components/IngestionPanel.jsx`
- Modify: `frontend/src/App.jsx`
- Test: `frontend/src/test/IngestionPanel.test.jsx`

The ingestion `<section className="glass ingestion-panel">` (lines 523-735) holds the four mode forms, the bulk progress bar, and the pipeline step tracker. It is the largest remaining block. Extract it as a presentational component that receives all state + handlers as props.

**Prop interface for `IngestionPanel`** (group by concern):
- mode: `mode`, `setMode`, `ingestionTabs`, `isLoading`
- url: `url`, `setUrl`, `handleUrlSubmit`
- file: `file`, `setFile`, `fileTitle`, `setFileTitle`, `fileCaption`, `setFileCaption`, `fileInputRef`, `handleFileDrop`, `handleFileSelect`, `handleFileSubmit`
- text: `textTitle`, `setTextTitle`, `textCaption`, `setTextCaption`, `textTranscript`, `setTextTranscript`, `handleTextSubmit`
- bulk: `batchFile`, `batchInputRef`, `handleBatchSelect`, `handleBatchSubmit`, `isBatchRunning`, `batchJob`
- progress: `currentStep`, `steps`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/test/IngestionPanel.test.jsx`:

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Link, FileAudio, FileText, UploadCloud } from 'lucide-react';
import IngestionPanel from '../components/IngestionPanel';

const tabs = [
  { key: 'url', label: 'Reel URL', Icon: Link },
  { key: 'file', label: 'Audio File', Icon: FileAudio },
  { key: 'text', label: 'Transcript Text', Icon: FileText },
  { key: 'bulk', label: 'Bulk Import', Icon: UploadCloud },
];

const baseProps = {
  mode: 'url', setMode: vi.fn(), ingestionTabs: tabs, isLoading: false,
  url: '', setUrl: vi.fn(), handleUrlSubmit: vi.fn((e) => e.preventDefault()),
  file: null, setFile: vi.fn(), fileTitle: '', setFileTitle: vi.fn(),
  fileCaption: '', setFileCaption: vi.fn(), fileInputRef: createRef(),
  handleFileDrop: vi.fn(), handleFileSelect: vi.fn(), handleFileSubmit: vi.fn(),
  textTitle: '', setTextTitle: vi.fn(), textCaption: '', setTextCaption: vi.fn(),
  textTranscript: '', setTextTranscript: vi.fn(), handleTextSubmit: vi.fn(),
  batchFile: null, batchInputRef: createRef(), handleBatchSelect: vi.fn(),
  handleBatchSubmit: vi.fn(), isBatchRunning: false, batchJob: null,
  currentStep: 1, steps: [{ num: 1, label: 'Server Check' }],
};

describe('IngestionPanel', () => {
  it('renders all four mode tabs', () => {
    render(<IngestionPanel {...baseProps} />);
    expect(screen.getByText('Reel URL')).toBeInTheDocument();
    expect(screen.getByText('Bulk Import')).toBeInTheDocument();
  });

  it('switches mode when a tab is clicked', () => {
    const setMode = vi.fn();
    render(<IngestionPanel {...baseProps} setMode={setMode} />);
    fireEvent.click(screen.getByText('Audio File'));
    expect(setMode).toHaveBeenCalledWith('file');
  });

  it('shows the URL input in url mode', () => {
    render(<IngestionPanel {...baseProps} />);
    expect(screen.getByPlaceholderText(/instagram.com\/reel/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test`
Expected: FAIL — cannot resolve `../components/IngestionPanel`.

- [ ] **Step 3: Create the component**

Create `frontend/src/components/IngestionPanel.jsx`. Move the `<section className="glass ingestion-panel"> ... </section>` JSX from `App.jsx` lines 523-735 verbatim into the component's return, with these prop substitutions only (no logic changes):
- The tab `.map` already uses `ingestionTabs`, `mode`, `setMode` — receive them as props.
- All `useState` setters and handler functions referenced in the JSX become props (full list in the prop interface above).
- `Clapperboard` is used by the URL input icon — import it from `lucide-react` in this file.

```jsx
import {
  Clapperboard, Link, FileAudio, FileText, UploadCloud, ArrowRight, Check,
} from 'lucide-react';

export default function IngestionPanel(props) {
  const {
    mode, setMode, ingestionTabs, isLoading,
    url, setUrl, handleUrlSubmit,
    file, fileTitle, setFileTitle, fileCaption, setFileCaption,
    fileInputRef, handleFileDrop, handleFileSelect, handleFileSubmit,
    textTitle, setTextTitle, textCaption, setTextCaption,
    textTranscript, setTextTranscript, handleTextSubmit,
    batchFile, batchInputRef, handleBatchSelect, handleBatchSubmit,
    isBatchRunning, batchJob,
    currentStep, steps,
  } = props;

  return (
    <section className="glass ingestion-panel">
      {/* PASTE lines 525-734 of the original App.jsx here verbatim:
          the tab-row div, the four `mode === '...'` form blocks, the bulk
          progress block, and the `isLoading` step tracker. Every identifier
          in that JSX is now provided via the destructured props above —
          no `this.` / no local state remains. */}
    </section>
  );
}
```

> Implementation note for the engineer: open `App.jsx` at the commit before this task, copy the inner JSX of the `ingestion-panel` section (everything between `<section className="glass ingestion-panel">` and its closing `</section>`), and paste it where the comment is. Do not rename any variable — they all match the destructured props. The icons referenced inside (`Clapperboard`, `Link`, `FileAudio`, `FileText`, `UploadCloud`, `ArrowRight`, `Check`) are imported at the top of this file.

- [ ] **Step 4: Wire it into App.jsx**

Add the import (after the ReelCard import):

```jsx
import IngestionPanel from './components/IngestionPanel';
```

Replace the entire `<section className="glass ingestion-panel"> ... </section>` block (lines 523-735) with:

```jsx
      <IngestionPanel
        mode={mode} setMode={setMode} ingestionTabs={ingestionTabs} isLoading={isLoading}
        url={url} setUrl={setUrl} handleUrlSubmit={handleUrlSubmit}
        file={file} setFile={setFile} fileTitle={fileTitle} setFileTitle={setFileTitle}
        fileCaption={fileCaption} setFileCaption={setFileCaption} fileInputRef={fileInputRef}
        handleFileDrop={handleFileDrop} handleFileSelect={handleFileSelect} handleFileSubmit={handleFileSubmit}
        textTitle={textTitle} setTextTitle={setTextTitle} textCaption={textCaption} setTextCaption={setTextCaption}
        textTranscript={textTranscript} setTextTranscript={setTextTranscript} handleTextSubmit={handleTextSubmit}
        batchFile={batchFile} batchInputRef={batchInputRef} handleBatchSelect={handleBatchSelect}
        handleBatchSubmit={handleBatchSubmit} isBatchRunning={isBatchRunning} batchJob={batchJob}
        currentStep={currentStep} steps={steps}
      />
```

After this, run `npm run lint` and remove any lucide icon imports from `App.jsx` that are now only used inside `IngestionPanel` (likely `FileAudio`, `FileText`, `Link`, `UploadCloud`, `Clapperboard` if not used elsewhere — note `Clapperboard` is still used in the header logo and dashboard, so keep it; `Search`, `AlertTriangle`, `X`, `Database`, `Sparkles` remain used in App).

- [ ] **Step 5: Run tests and lint**

Run (from `frontend/`): `npm test && npm run lint`
Expected: IngestionPanel tests pass, App baseline tests pass. Resolve unused-import lint flags.

- [ ] **Step 6: Build to confirm the full app still compiles**

Run (from `frontend/`): `npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/IngestionPanel.jsx frontend/src/App.jsx frontend/src/test/IngestionPanel.test.jsx
git commit -m "refactor(frontend): extract IngestionPanel component"
```

---

### Task C9: Final verification pass

**Files:**
- None (verification only)

- [ ] **Step 1: Confirm App.jsx is materially smaller**

Run (from repo root): `wc -l frontend/src/App.jsx`
Expected: well under 600 lines (down from 1047). The component now composes `IngestionPanel`, `InsightsTable`, `ReelCard`, `ReelModal`, and `Skeletons`, holding only state + handlers + the dashboard controls shell.

- [ ] **Step 2: Run the full frontend suite + lint + build**

Run (from `frontend/`): `npm test && npm run lint && npm run build`
Expected: all tests pass, lint clean, build succeeds.

- [ ] **Step 3: Run the full backend suite**

Run: `python backend/verify_pipeline.py`
Expected: `--- All tests completed successfully! ---`.

- [ ] **Step 4: Manual smoke test (no automated coverage for live data flow)**

Start backend (`backend/run_local.ps1`) and frontend (`npm run dev`). In the browser: confirm the dashboard loads, mode tabs switch, a card opens the modal, and the modal closes. This covers the wiring the unit tests stub out.

- [ ] **Step 5: Commit any final tidy-ups (if needed)**

```bash
git add -A
git commit -m "chore: final cleanup pass after review-code fixes"
```

---

## Self-Review Notes

- **Coverage vs review report:** Cross-file `_chunked` (A2) and `_run_pipeline` (A3); CORS critical (A6); dead `fetchClusters` (C1), unused `import db` (A7), deprecated `on_event` (A4), App.jsx split (C4-C8), redundant local imports (A1), tab-button map (C2), `row_to_record` guard (A5), polling churn (C3), `sys.exit` (A7), comment numbering (A8). `console.log` at App.jsx:148 is left intentionally (informational warm-up log, harmless) — noted, not changed. `verify_pipeline.py` pytest migration is out of scope per decision.
- **Type/name consistency:** Component prop names match between each component file and its `App.jsx` call site (verified per task). `_chunked(seq, size)` signature consistent across A2 call sites. `_run_pipeline` returns `(title, raw_transcript, post_caption, extracted)` and both callers destructure in that order.
- **Risk:** Frontend extraction has unit coverage per component plus App baseline tests, but no end-to-end coverage of live Supabase/HTTP flows — Task C9 step 4 manual smoke test covers that gap.
```
