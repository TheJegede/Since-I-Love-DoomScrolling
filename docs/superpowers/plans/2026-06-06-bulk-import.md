# Bulk Import of Saved Reels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a frontend "Bulk import" mode that uploads `saved_posts.json` and runs every saved reel through the extract pipeline as a server-side background job with live progress.

**Architecture:** Refactor the single-URL pipeline into a reusable `process_reel_url()`. A shared `parse_saved_posts()` parser feeds both the CLI and a new `POST /extract/batch` endpoint that runs a background thread, updating a module-level `BATCH_JOB` dict mirrored to `batch_progress.json`. Frontend polls `GET /extract/batch/status`.

**Tech Stack:** FastAPI (Python), SQLite, React 19 + Vite. Tests via `verify_pipeline.py` (FastAPI TestClient, plain asserts, mocked Groq).

---

## ⚠️ Test isolation note

The user is running `batch_import.py` live against `backend/batch_progress.json` while this is built. **Tests must never write the real `batch_progress.json`.** Every test that exercises batch progress MUST override `main.BATCH_PROGRESS_PATH` to a temp file and restore it in a `finally`.

## File Structure

- **Create** `backend/saved_parser.py` — pure `parse_saved_posts(data)`, no heavy deps. Shared by `main.py` and `batch_import.py`.
- **Modify** `backend/main.py` — add imports; `process_reel_url()`; rewrite `extract_url` as a wrapper; batch job state + `_run_batch()` + `_load/_save_batch_progress()`; `POST /extract/batch`; `GET /extract/batch/status`.
- **Modify** `backend/batch_import.py` — replace local `parse_saved` with import of `parse_saved_posts`.
- **Modify** `backend/verify_pipeline.py` — new tests.
- **Modify** `frontend/src/App.jsx` — `'bulk'` mode tab + panel + polling.

---

### Task 1: Shared `parse_saved_posts` parser

**Files:**
- Create: `backend/saved_parser.py`
- Modify: `backend/batch_import.py` (replace `parse_saved`)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py` (before the `__main__` block):

```python
def test_parse_saved_posts():
    print("Testing parse_saved_posts filters reels...")
    from saved_parser import parse_saved_posts
    sample = [
        {"label_values": [
            {"label": "URL", "value": "https://www.instagram.com/reel/AAA/"},
            {"label": "Caption", "value": "hello"},
            {"label": "Title", "value": "T1"}]},
        {"label_values": [
            {"label": "URL", "value": "https://www.instagram.com/p/BBB/"},
            {"label": "Caption", "value": "photo"}]},
    ]
    out = parse_saved_posts(sample)
    assert len(out) == 1, out
    assert out[0]["url"].endswith("/reel/AAA/")
    assert out[0]["caption"] == "hello"
    assert out[0]["title"] == "T1"
    print("[OK] parse_saved_posts passed!")
```

And register it in `__main__`:

```python
    test_parse_saved_posts()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python backend/verify_pipeline.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'saved_parser'`.

- [ ] **Step 3: Create `backend/saved_parser.py`**

```python
"""Pure parser for the Instagram 'Download Your Information' saved_posts.json.

No heavy dependencies — safe to import from both the FastAPI app and the CLI.
"""


def parse_saved_posts(data):
    """Return [{url, caption, title}] for every /reel/ URL in the export.

    `data` is the parsed JSON list from saved_posts.json. Photo (/p/) posts
    are dropped because they have no audio.
    """
    items = []
    for entry in data:
        url = caption = title = ""
        for lv in entry.get("label_values", []):
            label = lv.get("label")
            if label == "URL":
                url = lv.get("value", "")
            elif label == "Caption":
                caption = lv.get("value", "")
            elif label == "Title":
                title = lv.get("value", "")
        if "/reel/" in url:
            items.append({"url": url, "caption": caption, "title": title})
    return items
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python backend/verify_pipeline.py`
Expected: PASS — `[OK] parse_saved_posts passed!`

- [ ] **Step 5: Refactor `batch_import.py` to use the shared parser**

In `backend/batch_import.py`, replace the entire `def parse_saved(json_path): ...` function with:

```python
from saved_parser import parse_saved_posts


def parse_saved(json_path):
    """Return list of {url, caption, title} for every /reel/ URL in the export."""
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    return parse_saved_posts(data)
```

- [ ] **Step 6: Verify CLI still parses**

Run: `python backend/batch_import.py "C:\Users\jeged\Downloads\ig_export\your_instagram_activity\saved\saved_posts.json" --limit 0`
Expected: prints `Found 344 reels in export.` then `Queue: ... reels` (limit 0 = process remaining; Ctrl+C immediately if the live run is mid-flight — this is only confirming the parse line prints).

- [ ] **Step 7: Commit**

```bash
git add backend/saved_parser.py backend/batch_import.py backend/verify_pipeline.py
git commit -m "refactor(backend): shared parse_saved_posts for CLI + upcoming batch endpoint"
```

---

### Task 2: Extract `process_reel_url()` from `extract_url`

**Files:**
- Modify: `backend/main.py:482-548` (the `extract_url` handler)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/verify_pipeline.py`:

```python
def test_extract_url_regression():
    print("Testing POST /extract/url via process_reel_url (mocked)...")
    import main
    long_transcript = " ".join(["word"] * 30)  # clears the 15-word silent-hook guard
    mocked = ReelExtraction(
        core_topic="Topic", key_takeaway="Takeaway",
        action_items=["a"], tools_or_resources=["b"])
    orig_dl = main.download_and_extract_audio
    orig_tr = main.transcribe_audio
    orig_ex = main.extract_structured_json
    orig_save = main.save_to_database
    main.download_and_extract_audio = lambda url: ("/tmp/does_not_exist.mp3", "cap", "Title")
    main.transcribe_audio = lambda p: long_transcript
    main.extract_structured_json = lambda t, c: mocked
    main.save_to_database = lambda url, title, raw_transcript, post_caption, extracted: {
        "id": "id-1", "url": url, "title": title,
        "raw_transcript": raw_transcript, "post_caption": post_caption,
        "extracted_json": extracted.model_dump(), "created_at": "2026-06-06T00:00:00Z"}
    try:
        r = client.post("/extract/url", json={"url": "https://www.instagram.com/reel/REGRESSION1/"})
        assert r.status_code == 200, r.text
        assert r.json()["extracted_json"]["core_topic"] == "Topic"
        print("[OK] extract_url regression passed!")
    finally:
        main.download_and_extract_audio = orig_dl
        main.transcribe_audio = orig_tr
        main.extract_structured_json = orig_ex
        main.save_to_database = orig_save
```

Register in `__main__`:

```python
    test_extract_url_regression()
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `python backend/verify_pipeline.py`
Expected: PASS already (the endpoint works today). This test locks behavior before the refactor — if it fails now, stop and fix the test.

- [ ] **Step 3: Refactor — add `process_reel_url`, slim the handler**

In `backend/main.py`, replace the whole `extract_url` handler (currently `main.py:482-548`) with:

```python
def process_reel_url(url: str) -> dict:
    """Full single-reel pipeline. Returns the saved DB record.

    Returns the cached row if this URL was already processed. Raises
    HTTPException(400) on silent-hook reels (no spoken content). Always
    cleans up the temp audio file.
    """
    # Cache: skip inference if we already have this URL
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT id, url, title, raw_transcript, post_caption, extracted_json, created_at FROM saved_reels WHERE url = ?", (url,))
        row = cursor.fetchone()
        conn.close()
        if row:
            logger.info(f"Returning cached SQLite database record for URL: {url}")
            return {
                "id": row[0],
                "url": row[1],
                "title": row[2],
                "raw_transcript": row[3],
                "post_caption": row[4],
                "extracted_json": json.loads(row[5]),
                "created_at": row[6],
            }
    except Exception as e:
        logger.warning(f"Failed to check existing SQLite URL cache: {str(e)}")

    mp3_path = None
    try:
        mp3_path, post_caption, title = download_and_extract_audio(url)
        raw_transcript = ""
        try:
            raw_transcript = transcribe_audio(mp3_path)
        except Exception as e:
            logger.warning(f"Transcription failed: {str(e)}. Proceeding using metadata/caption only.")
        guard_silent_hook(raw_transcript, post_caption)
        extracted_data = extract_structured_json(raw_transcript, post_caption)
        return save_to_database(
            url=url,
            title=title,
            raw_transcript=raw_transcript,
            post_caption=post_caption,
            extracted=extracted_data,
        )
    finally:
        if mp3_path and os.path.exists(mp3_path):
            try:
                os.remove(mp3_path)
                logger.info(f"Cleaned up temporary audio file: {mp3_path}")
            except Exception as ce:
                logger.warning(f"Could not delete temp file {mp3_path}: {str(ce)}")


@app.post("/extract/url", response_model=ExtractionResponse)
async def extract_url(payload: dict):
    """Accepts an Instagram Reel URL and runs the full extraction pipeline."""
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing required 'url' parameter.")
    return process_reel_url(url)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python backend/verify_pipeline.py`
Expected: PASS — `[OK] extract_url regression passed!` plus all prior tests.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "refactor(backend): extract process_reel_url from extract_url handler"
```

---

### Task 3: Batch job state + endpoints

**Files:**
- Modify: `backend/main.py` (imports near top; new code after `process_reel_url` and the `/extract/url` route)
- Test: `backend/verify_pipeline.py`

- [ ] **Step 1: Add imports**

In `backend/main.py`, change the top imports. Replace line 4 area — add `threading`, `time`, and a datetime import. After `import logging` (line 4) add:

```python
import threading
import time
from datetime import datetime, timezone
```

And add near the other local imports (after `import sqlite3` at `main.py:32`):

```python
from saved_parser import parse_saved_posts
```

- [ ] **Step 2: Write the failing tests**

Add to `backend/verify_pipeline.py`:

```python
def test_batch_status_initial():
    print("Testing GET /extract/batch/status shape...")
    r = client.get("/extract/batch/status")
    assert r.status_code == 200, r.text
    body = r.json()
    for key in ("status", "total", "done", "ok", "failed", "current", "errors"):
        assert key in body, f"missing {key} in {body}"
    print("[OK] batch status shape passed!")


def test_batch_guard_409():
    print("Testing POST /extract/batch returns 409 while running...")
    import main, io, json as _json
    prev = dict(main.BATCH_JOB)
    main.BATCH_JOB["status"] = "running"
    try:
        files = {"file": ("saved_posts.json", io.BytesIO(b"[]"), "application/json")}
        r = client.post("/extract/batch", files=files)
        assert r.status_code == 409, r.text
        print("[OK] batch 409 guard passed!")
    finally:
        main.BATCH_JOB.update(prev)
        main.BATCH_JOB["status"] = "idle"


def test_run_batch_direct():
    print("Testing _run_batch processes a queue (mocked)...")
    import main, tempfile, os as _os
    # Isolate progress file so the live CLI run is never touched
    tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
    tmp.close()
    orig_path = main.BATCH_PROGRESS_PATH
    orig_proc = main.process_reel_url
    main.BATCH_PROGRESS_PATH = tmp.name
    main.process_reel_url = lambda url: {"id": "x", "url": url}
    try:
        reels = [
            {"url": "https://www.instagram.com/reel/R1/", "caption": "", "title": ""},
            {"url": "https://www.instagram.com/reel/R2/", "caption": "", "title": ""},
        ]
        main._run_batch(reels, delay=0)
        assert main.BATCH_JOB["status"] == "done", main.BATCH_JOB
        assert main.BATCH_JOB["ok"] == 2, main.BATCH_JOB
        assert main.BATCH_JOB["failed"] == 0
        print("[OK] _run_batch passed!")
    finally:
        main.process_reel_url = orig_proc
        main.BATCH_PROGRESS_PATH = orig_path
        main.BATCH_JOB["status"] = "idle"
        _os.unlink(tmp.name)
```

Register all three in `__main__`:

```python
    test_batch_status_initial()
    test_batch_guard_409()
    test_run_batch_direct()
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `python backend/verify_pipeline.py`
Expected: FAIL — `404` on `/extract/batch/status` / `AttributeError: module 'main' has no attribute 'BATCH_PROGRESS_PATH'`.

- [ ] **Step 4: Implement batch job + endpoints**

In `backend/main.py`, after the `/extract/url` route added in Task 2, add:

```python
BATCH_PROGRESS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "batch_progress.json")

BATCH_JOB = {
    "status": "idle",   # idle | running | done | error
    "total": 0,
    "done": 0,
    "ok": 0,
    "failed": 0,
    "current": "",
    "errors": [],        # capped list of {url, detail}
    "started_at": None,
    "finished_at": None,
}


def _load_batch_progress():
    if os.path.exists(BATCH_PROGRESS_PATH):
        try:
            with open(BATCH_PROGRESS_PATH, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save_batch_progress(progress):
    with open(BATCH_PROGRESS_PATH, "w", encoding="utf-8") as f:
        json.dump(progress, f, indent=2)


def _run_batch(reels, delay=3.0):
    """Background worker: process each not-yet-done reel, updating BATCH_JOB
    and the on-disk progress ledger after each one."""
    progress = _load_batch_progress()
    queue = [r for r in reels if progress.get(r["url"], {}).get("status") != "ok"]
    BATCH_JOB.update({
        "status": "running",
        "total": len(queue),
        "done": 0, "ok": 0, "failed": 0,
        "current": "", "errors": [],
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
    })
    try:
        for r in queue:
            url = r["url"]
            BATCH_JOB["current"] = url
            try:
                process_reel_url(url)
                progress[url] = {"status": "ok"}
                BATCH_JOB["ok"] += 1
            except HTTPException as e:
                progress[url] = {"status": "failed", "detail": str(e.detail)}
                BATCH_JOB["failed"] += 1
                BATCH_JOB["errors"] = (BATCH_JOB["errors"] + [{"url": url, "detail": str(e.detail)}])[-50:]
            except Exception as e:
                progress[url] = {"status": "failed", "detail": str(e)}
                BATCH_JOB["failed"] += 1
                BATCH_JOB["errors"] = (BATCH_JOB["errors"] + [{"url": url, "detail": str(e)}])[-50:]
            BATCH_JOB["done"] += 1
            _save_batch_progress(progress)
            if delay:
                time.sleep(delay)
        BATCH_JOB["status"] = "done"
    except Exception as e:
        BATCH_JOB["status"] = "error"
        BATCH_JOB["errors"] = (BATCH_JOB["errors"] + [{"url": "", "detail": f"fatal: {e}"}])[-50:]
    finally:
        BATCH_JOB["current"] = ""
        BATCH_JOB["finished_at"] = datetime.now(timezone.utc).isoformat()


@app.post("/extract/batch")
async def extract_batch(file: UploadFile = File(...)):
    """Accept an uploaded saved_posts.json and start a background import job."""
    if BATCH_JOB["status"] == "running":
        raise HTTPException(status_code=409, detail="A batch import is already running.")
    try:
        raw = await file.read()
        data = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not parse uploaded JSON.")
    reels = parse_saved_posts(data)
    if not reels:
        raise HTTPException(status_code=400, detail="No reel URLs found in the uploaded file.")
    progress = _load_batch_progress()
    queued = [r for r in reels if progress.get(r["url"], {}).get("status") != "ok"]
    # Close the race window before the worker thread sets status itself
    BATCH_JOB["status"] = "running"
    threading.Thread(target=_run_batch, args=(reels,), daemon=True).start()
    return {"started": True, "total": len(queued)}


@app.get("/extract/batch/status")
async def extract_batch_status():
    return BATCH_JOB
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python backend/verify_pipeline.py`
Expected: PASS — `[OK] batch status shape passed!`, `[OK] batch 409 guard passed!`, `[OK] _run_batch passed!`, plus all prior tests.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/verify_pipeline.py
git commit -m "feat(backend): POST /extract/batch background job + status endpoint"
```

---

### Task 4: Frontend bulk-import mode

**Files:**
- Modify: `frontend/src/App.jsx` (state ~line 39-47; handlers after `handleFileSubmit` ~line 239; tab buttons ~line 379-385; panels after the `text` panel ~line 489)

No automated tests (no frontend test harness); manual verification in Step 5.

- [ ] **Step 1: Add state + ref**

In `frontend/src/App.jsx`, after the file-mode state block (`const fileInputRef = useRef(null);` at line 42) add:

```jsx
  // Bulk import (saved_posts.json)
  const batchInputRef = useRef(null);
  const [batchFile, setBatchFile] = useState(null);
  const [batchJob, setBatchJob] = useState(null);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
```

- [ ] **Step 2: Add handlers + polling effect**

After `handleFileSubmit` (ends at `main.py` analogue line 239 in App.jsx) add:

```jsx
  const handleBatchSelect = (e) => {
    const selected = e.target.files[0];
    if (selected) setBatchFile(selected);
  };

  const pollBatchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/extract/batch/status`);
      if (!res.ok) return;
      const job = await res.json();
      setBatchJob(job);
      if (job.status !== 'running') {
        setIsBatchRunning(false);
        fetchReels();
        fetchClusters();
      }
    } catch {
      // transient network error during polling — ignore, next tick retries
    }
  };

  const handleBatchSubmit = async (e) => {
    e.preventDefault();
    if (!batchFile) return;
    setError(null);
    const formData = new FormData();
    formData.append('file', batchFile);
    try {
      const res = await fetch(`${API_BASE_URL}/extract/batch`, { method: 'POST', body: formData });
      if (res.status === 409) {
        // a job is already running (e.g. the CLI or a prior upload) — attach to it
        setIsBatchRunning(true);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to start batch import.');
      }
      setIsBatchRunning(true);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (!isBatchRunning) return;
    pollBatchStatus();
    const id = setInterval(pollBatchStatus, 2000);
    return () => clearInterval(id);
  }, [isBatchRunning]);
```

- [ ] **Step 3: Add the tab button**

In the tab row, after the `Transcript Text` button (closes at line 385) add:

```jsx
          <button 
            className={`alt-input-btn ${mode === 'bulk' ? 'active' : ''}`}
            onClick={() => setMode('bulk')}
            style={{ borderBottom: mode === 'bulk' ? '2px solid var(--accent-primary)' : 'none', paddingBottom: '0.5rem', color: mode === 'bulk' ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <UploadCloud size={16} /> Bulk Import
          </button>
```

(`UploadCloud` is already imported — used by the file panel.)

- [ ] **Step 4: Add the bulk panel**

After the `{mode === 'text' && ( ... )}` block closes, add:

```jsx
        {mode === 'bulk' && (
          <form onSubmit={handleBatchSubmit}>
            <div 
              className="upload-zone"
              onClick={() => batchInputRef.current.click()}
            >
              <input 
                type="file" 
                ref={batchInputRef} 
                onChange={handleBatchSelect} 
                accept="application/json,.json" 
                style={{ display: 'none' }} 
              />
              <UploadCloud size={40} className="empty-state-icon" style={{ margin: '0 auto 1rem auto' }} />
              {batchFile ? (
                <div>
                  <p style={{ fontWeight: '600', color: 'var(--accent-primary)' }}>{batchFile.name}</p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{(batchFile.size / 1024).toFixed(0)} KB</p>
                </div>
              ) : (
                <div>
                  <p style={{ fontWeight: '600' }}>Upload your Instagram saved_posts.json</p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>From "Download Your Information" → Saved (JSON). Reels only; photos skipped.</p>
                </div>
              )}
            </div>

            <button type="submit" className="btn-primary" style={{ alignSelf: 'flex-start', marginTop: '1rem' }} disabled={isBatchRunning || !batchFile}>
              {isBatchRunning ? "Importing..." : "Start Bulk Import"}
            </button>

            {batchJob && (
              <div style={{ marginTop: '1.5rem' }}>
                <div style={{ height: '8px', background: 'var(--bg-input)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${batchJob.total ? Math.round((batchJob.done / batchJob.total) * 100) : 0}%`,
                    background: 'var(--accent-primary)',
                    transition: 'width 0.4s ease'
                  }} />
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                  {batchJob.status === 'running' ? 'Running' : batchJob.status === 'done' ? 'Done' : batchJob.status} — {batchJob.done}/{batchJob.total} · ok {batchJob.ok} · failed {batchJob.failed}
                </p>
                {batchJob.current && batchJob.status === 'running' && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all' }}>Now: {batchJob.current}</p>
                )}
              </div>
            )}
          </form>
        )}
```

- [ ] **Step 5: Manual verification**

Start backend (`backend/run_local.ps1`) and frontend (`cd frontend; npm run dev`). Then:
1. Open the app → click **Bulk Import** tab → tab highlights, panel shows upload zone.
2. Upload `saved_posts.json` → filename + size appear.
3. Click **Start Bulk Import** → progress bar appears, `done/total` ticks up every ~2s, "Now: <url>" updates. (If the CLI run is still active, expect an immediate attach to that running job instead of a new one.)
4. Let a few complete → new reels appear in the results grid below (after the job finishes, reels + clusters refetch).
5. Run `npm run lint` → no new errors.

Run: `cd frontend; npm run lint`
Expected: passes (no new warnings from the added code).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "feat(frontend): bulk import mode uploads saved_posts.json with live progress"
```

---

## Self-Review

- **Spec coverage:** process_reel_url refactor (T2) ✓; shared parser (T1) ✓; BATCH_JOB + progress file (T3) ✓; POST /extract/batch + 409 + status (T3) ✓; background loop + throttle + skip-done (T3) ✓; frontend tab + upload + poll + refetch (T4) ✓; JSON-only / no zip / drop /p/ ✓; test isolation of progress file ✓.
- **Placeholder scan:** none — all steps carry full code/commands.
- **Type consistency:** `parse_saved_posts` returns `{url, caption, title}` used identically in CLI, `_run_batch`, and endpoint. `BATCH_JOB` keys match between definition, `_run_batch`, tests, and frontend rendering (`status/total/done/ok/failed/current`). `process_reel_url(url)` signature consistent across `/extract/url`, `_run_batch`, and mocks.
```
