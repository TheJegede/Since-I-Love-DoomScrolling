# Plan 004: Make Cluster Recomputation Asynchronous

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9537dd6..HEAD -- backend/main.py frontend/src/App.jsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The API route `/clusters/recompute` runs synchronously in the FastAPI request thread. Because clustering is chunked and delayed to respect Groq's token-per-minute (TPM) limits, it takes 30+ seconds for moderate-sized databases. In serverless and hosted environments (like Vercel and Hugging Face Spaces), this synchronous blocking exceeds the HTTP gateway timeout limits (usually 30–60s), causing client requests to crash or time out.

Refactoring this to run in a background task thread and implementing polling in the React client ensures reliability for any database size.

## Current state

- Relevant files:
  - `backend/main.py` — contains `/clusters/recompute` route (lines 494–527).
  - `frontend/src/App.jsx` — contains `handleRecompute` function (lines 159–174).
- Excerpt from `backend/main.py`:
  ```python
  @app.post("/clusters/recompute")
  def recompute_clusters():
      """Regroup all saved reels into emergent topic clusters via one LLM call."""
      try:
          rows = db.reels_for_clustering()
          ...
          assignments = cluster_topics_with_llm(items)
          ...
          for a in assignments:
              if a.get("id") in valid_ids and a.get("cluster"):
                  db.set_cluster(a["id"], a["cluster"])
                  applied += 1
  
          logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
          return {"clusters": db.cluster_counts(), "assigned": applied}
      ...
  ```
- Excerpt from `frontend/src/App.jsx`:
  ```javascript
    const handleRecompute = async () => {
      setIsRecomputing(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE_URL}/clusters/recompute`, { method: 'POST' });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || 'Recompute failed.');
        }
        await fetchReels();
      } catch (err) {
        setError(err.message);
      } finally {
        setIsRecomputing(false);
      }
    };
  ```

## Commands you will need

| Purpose   | Command                                                   | Expected on success |
|-----------|-----------------------------------------------------------|---------------------|
| Backend   | `backend/.venv/Scripts/python backend/verify_pipeline.py`     | all 20+ tests pass  |
| Frontend  | `cd frontend && npm run test`                             | all tests pass      |
| Build     | `cd frontend && npm run build`                            | compiles clean      |

## Scope

**In scope**:
- `backend/main.py`
- `backend/verify_pipeline.py`
- `frontend/src/App.jsx`

**Out of scope**:
- Database operations in `backend/db.py`

## Steps

### Step 1: Add BackgroundTasks and CLUSTER_JOB state to backend/main.py

Update `backend/main.py` imports to include `BackgroundTasks` from `fastapi`.
Add a global tracking dictionary `CLUSTER_JOB`:
```python
CLUSTER_JOB = {
    "status": "idle",  # idle | running | done | error
    "started_at": None,
    "finished_at": None,
    "assigned": 0,
    "error": None,
}
```

### Step 2: Implement background recomputation task

Extract the core clustering logic from `recompute_clusters` into a separate non-endpoint function `run_cluster_recompute_task()`. Have it update `CLUSTER_JOB` status to `running`, execute the DB and Groq operations, and set the status to `done` or `error` in `finally` or `except` blocks.

Target shape:
```python
def run_cluster_recompute_task():
    global CLUSTER_JOB
    CLUSTER_JOB.update({
        "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "assigned": 0,
        "error": None,
    })
    try:
        rows = db.reels_for_clustering()
        if not rows:
            CLUSTER_JOB.update({
                "status": "done",
                "finished_at": datetime.now(timezone.utc).isoformat(),
            })
            return

        items = []
        for r in rows:
            ej = r.get("extracted_json")
            if isinstance(ej, str):
                try:
                    ej = json.loads(ej)
                except Exception:
                    ej = {}
            items.append({"id": r["id"], "topic": (ej or {}).get("core_topic", "")})

        assignments = cluster_topics_with_llm(items)
        valid_ids = {r["id"] for r in rows}
        applied = 0
        for a in assignments:
            if a.get("id") in valid_ids and a.get("cluster"):
                db.set_cluster(a["id"], a["cluster"])
                applied += 1

        logger.info(f"Recomputed clusters: assigned {applied} of {len(rows)} reels.")
        CLUSTER_JOB.update({
            "status": "done",
            "assigned": applied,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.error(f"Cluster recompute task failed: {str(e)}")
        CLUSTER_JOB.update({
            "status": "error",
            "error": str(e),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
```

### Step 3: Update POST route and add GET status route in backend/main.py

Update `@app.post("/clusters/recompute")` to receive `background_tasks: BackgroundTasks` and submit the task. If a job is already running, raise a `409 Conflict`.
Add `@app.get("/clusters/recompute/status")` to return `CLUSTER_JOB`.

Target shape:
```python
from fastapi import BackgroundTasks

@app.post("/clusters/recompute")
def recompute_clusters(background_tasks: BackgroundTasks):
    """Trigger cluster recomputation in the background."""
    if CLUSTER_JOB["status"] == "running":
        raise HTTPException(status_code=409, detail="Cluster recomputation is already in progress.")
        
    background_tasks.add_task(run_cluster_recompute_task)
    return {"status": "started", "message": "Cluster recomputation started in the background."}

@app.get("/clusters/recompute/status")
def get_recompute_status():
    """Poll endpoint to check recomputation status."""
    return CLUSTER_JOB
```

### Step 4: Fix mock tests in backend/verify_pipeline.py

Open `backend/verify_pipeline.py` and modify the test cases hitting `POST /clusters/recompute`. Since it's now async, mock or check the initial return payload.
Add a test for `GET /clusters/recompute/status`.

**Verify**: Run `backend/.venv/Scripts/python backend/verify_pipeline.py` to ensure all backend tests pass.

### Step 5: Update handleRecompute polling in frontend/src/App.jsx

Update the React component in `frontend/src/App.jsx` to poll `/clusters/recompute/status`.
In `handleRecompute`, trigger the POST route. If successful, enter a polling loop using `setInterval` or recursive `setTimeout` every 3 seconds. Keep `isRecomputing` set to `true` until the returned status is `"done"` or `"error"`. When finished, refresh the reels list with `fetchReels()` and clear the recomputing state.

Target shape:
```javascript
  const handleRecompute = async () => {
    setIsRecomputing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/clusters/recompute`, { method: 'POST' });
      if (res.status === 409) {
        // Already running, start polling
        startRecomputePolling();
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Recompute failed.');
      }
      
      startRecomputePolling();
    } catch (err) {
      setError(err.message);
      setIsRecomputing(false);
    }
  };

  const startRecomputePolling = () => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/clusters/recompute/status`);
        if (!res.ok) return;
        const job = await res.json();
        if (job.status !== 'running') {
          clearInterval(intervalId);
          setIsRecomputing(false);
          if (job.status === 'error') {
            setError(job.error || 'Recompute failed in background.');
          } else {
            await fetchReels();
          }
        }
      } catch (err) {
        console.error("Error polling cluster recompute status", err);
      }
    };

    const intervalId = setInterval(poll, 3000);
    poll(); // run immediately
  };
```

**Verify**: Run `cd frontend && npm run test` and verify that the build is clean via `npm run build`.

## Test plan

- Run `backend/.venv/Scripts/python backend/verify_pipeline.py` to verify backend changes.
- Mock status endpoint responses in `App.test.jsx` to test polling UI state updates.
- Verify frontend test suite passes cleanly: `cd frontend && npm run test`.

## Done criteria

- [ ] Recomputation endpoint returns immediately and submits a FastAPI background task.
- [ ] `/clusters/recompute/status` endpoint exposes recomputation state.
- [ ] React frontend polls the status endpoint and unlocks the button only after completion.
- [ ] All tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If the server has a multi-process worker pool (like gunicorn with multiple worker processes) where memory is not shared between processes (FastAPI background task will run in one process, but a polling request might land on another process). Since the deployment target is a single free Hugging Face CPU container (running uvicorn directly, single worker), process memory is shared. If multi-process is introduced later, state must be moved to Supabase or Redis.

## Maintenance notes

- If multiple web users recompute clusters concurrently, they will poll the same global `CLUSTER_JOB` state.
