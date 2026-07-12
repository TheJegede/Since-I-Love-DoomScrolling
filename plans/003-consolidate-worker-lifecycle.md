# Plan 003: Consolidate worker lifecycle and add stage timing

> **Executor instructions**: This plan is optional. Do not start it merely because it exists. Execute it only after Plans 001 and 002 are stable and the maintainer wants easier debugging or less duplicated worker code.
>
> **Drift check (run first)**: `git diff --stat 4a5e5e3..HEAD -- backend/main.py backend/run_worker.py backend/verify_pipeline.py`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 001; preferably Plan 002
- **Category**: tech debt, DX, performance measurement
- **Planned at**: commit `4a5e5e3`, 2026-07-12

## Why this matters

The infinite loop is implemented separately in `main.py` and `run_worker.py`, so shutdown, backoff, recovery, and future changes can drift. The pipeline also has no stage timings, making performance work speculative. For a personal project, one reusable loop plus ordinary structured log fields is enough; an external monitoring platform is not warranted.

## Scope

**In scope:**

- Create `backend/worker.py`
- `backend/main.py`
- `backend/run_worker.py`
- `backend/verify_pipeline.py`
- `plans/README.md`

**Out of scope:**

- Metrics vendors, dashboards, OpenTelemetry, or paid logging
- Splitting all of `main.py`
- Parallel pipeline stages
- Changing API response models
- Changing the queue schema beyond Plan 002

## Steps

### Step 1: Create one reusable worker loop

Move loop orchestration—not pipeline logic—into `backend/worker.py`. The reusable function should accept injected callables/events so it can be tested without importing FastAPI or starting an infinite loop:

```python
run_worker_loop(
    tick,
    stop_event,
    idle_interval,
    drain=False,
    sleep=time.sleep,
)
```

Behavior:

- Successful work immediately tries another job.
- Empty queue waits `idle_interval` unless in drain mode.
- A tick exception is logged, waits `idle_interval`, and continues unless in drain mode.
- `stop_event` ends the loop promptly.

Use this function from both FastAPI and the standalone entrypoint.

**Verify**: unit tests use fake tick/sleep/event objects and cover work, empty, crash, drain, and stop cases without real sleeping.

### Step 2: Add graceful FastAPI shutdown

In the lifespan handler, retain the thread and a `threading.Event`. On shutdown, set the event and join with a short timeout. Log a warning if it does not stop; do not block shutdown indefinitely.

Keep the Hugging Face worker-disable rule exactly as it is.

**Verify**: a lifespan test asserts start and stop signals without creating a real worker.

### Step 3: Log local stage durations

Instrument `_run_pipeline` using `time.monotonic()` and log durations for download, transcription, extraction, and total processing. Use one concise completion log per Reel. Do not log transcript/caption content or secret values.

Do not persist timing columns yet. After processing at least 20 real Reels, use logs to decide whether controlled concurrency or a different optimization is justified.

**Verify**: a mocked pipeline test asserts timing keys/stage names appear without requiring exact durations.

### Step 4: Run the baseline

```powershell
.\backend\.venv\Scripts\python.exe backend\verify_pipeline.py
cd frontend
npm test
npm run lint
npm run build
```

Expected: all exit 0.

## Done criteria

- [ ] Exactly one worker-loop implementation exists.
- [ ] Standalone `--drain` behavior remains supported.
- [ ] FastAPI shutdown signals and joins its worker thread.
- [ ] Tests never sleep or contact external services.
- [ ] Pipeline completion logs include per-stage and total durations.
- [ ] No transcript, caption, cookie, or secret content is added to logs.
- [ ] Full baseline passes.

## STOP conditions

- Consolidation requires moving pipeline functions or route handlers beyond the scope above.
- FastAPI tests become timing-dependent or flaky.
- Existing deployment scripts import private symbols from either old loop.
- The maintainer has not completed Plan 001.

## Maintenance notes

Use the timing data before attempting concurrency. If download dominates and Instagram remains stable, a future experiment may overlap one download with one Groq job, capped at two in-flight Reels. If Groq dominates or returns rate limits, concurrency is not the right optimization.
