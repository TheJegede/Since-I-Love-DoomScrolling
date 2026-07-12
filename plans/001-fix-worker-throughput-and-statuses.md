# Plan 001: Fix worker throughput and terminal status handling

> **Executor instructions**: Follow this plan in order. Run every verification command. If a STOP condition occurs, report it instead of expanding scope. When complete, change this plan's status in `plans/README.md` from `TODO` to `DONE`.
>
> **Drift check (run first)**: `git diff --stat 4a5e5e3..HEAD -- backend/main.py backend/run_worker.py backend/verify_pipeline.py frontend/src/components/IngestionPanel.jsx`
> If these files changed, compare the current code with the evidence below before editing.

## Status

- **Priority**: P1
- **Effort**: S (hours)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug, performance, dependencies
- **Planned at**: commit `4a5e5e3`, 2026-07-12

## Why this matters

The worker sleeps five seconds after every processed Reel, adding avoidable latency to every batch. Batch progress also recognizes only `failed` as failure even though the worker emits `cookies_expired` and `unsupported_format`; those batches can remain `running` forever. Finally, standalone startup runs an unbounded `pip install --upgrade yt-dlp`, making startup slower and non-reproducible.

This plan delivers the highest-value improvements without changing the Supabase schema or adding services.

## Current state

- `backend/main.py:728-735` maps HTTP 403 to `cookies_expired` and HTTP 415 to `unsupported_format`.
- `backend/main.py:883-892` treats only `done` and `failed` as terminal; other statuses increment `processing`.
- `backend/main.py:750-759` sleeps `poll_interval` after successful work and `idle_interval` when no row is claimed.
- `backend/run_worker.py:22-34` upgrades yt-dlp at every startup.
- `backend/run_worker.py:57` repeats the successful-work delay.
- `backend/verify_pipeline.py` is a direct assertion-based test script; extend its existing worker and batch tests instead of introducing a new test framework.

Preserve the silent-hook guard, structured-output model, temp-file cleanup, and residential-worker deployment constraint described in `AGENTS.md`.

## Scope

**In scope:**

- `backend/main.py`
- `backend/run_worker.py`
- `backend/verify_pipeline.py`
- `frontend/src/components/IngestionPanel.jsx` only if its batch error display needs a small compatibility adjustment
- `plans/README.md`

**Out of scope:**

- Supabase schema changes
- Retry behavior
- Multiple-worker concurrency
- Pipeline model or prompt changes
- Frontend redesign
- Dependency upgrades

## Steps

### Step 1: Centralize queue status classification

In `backend/main.py`, define immutable status sets near the batch/worker state:

```python
ACTIVE_REEL_STATUSES = frozenset({"pending", "processing"})
SUCCESS_REEL_STATUSES = frozenset({"done"})
FAILURE_REEL_STATUSES = frozenset({"failed", "cookies_expired", "unsupported_format"})
```

Update `update_batch_job_status` so success statuses increment `ok`, failure statuses increment `failed` and append their error, and only active statuses increment `processing`. For an unknown status, count it as failed with an explicit `Unknown queue status: <status>` error so the UI cannot poll forever.

Add tests covering `cookies_expired`, `unsupported_format`, and an unknown status. Assert that each makes the batch terminal and increments `failed`.

**Verify**: `.\backend\.venv\Scripts\python.exe backend\verify_pipeline.py` → exit 0 and all tests complete successfully.

### Step 2: Drain queued work without a successful-work sleep

Change both loops so a successful `worker_tick()` immediately continues to the next claim. Sleep only when no work was claimed or when a top-level tick failure occurred. Preserve `--drain` behavior.

Do not add parallelism. The pipeline must remain one Reel at a time.

Extract a small pure helper only if needed to test interval selection; otherwise keep the change direct. Add a test around a bounded loop/helper rather than testing an infinite loop.

**Verify**: `rg -n "sleep\(.*did_work|poll_interval if did_work|5\.0 if did_work" backend` → no matches.

### Step 3: Remove automatic pip mutation from startup

Delete the startup `subprocess.run(... pip install --upgrade yt-dlp ...)` block from `backend/run_worker.py`. Log the installed yt-dlp version at startup if it can be done with an already-importable API; failure to obtain the version must not prevent startup.

Add a documented maintenance command to the worker module docstring or README worker section:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install --upgrade yt-dlp
```

Do not change the dependency version in this plan.

**Verify**: `rg -n "pip.*install|subprocess" backend/run_worker.py` → no matches.

### Step 4: Run the full baseline

```powershell
.\backend\.venv\Scripts\python.exe backend\verify_pipeline.py
cd frontend
npm test
npm run lint
npm run build
```

Expected: every command exits 0. The frontend suite must still report at least 17 passing tests.

## Done criteria

- [ ] All known failure statuses finish batch polling and increment `failed`.
- [ ] Unknown statuses cannot leave a batch running forever.
- [ ] A successful worker tick immediately attempts another claim.
- [ ] Empty queues still back off rather than busy-looping.
- [ ] Worker startup never installs or upgrades a package.
- [ ] Backend verification and frontend test/lint/build commands pass.
- [ ] No files outside the scope list are modified.

## STOP conditions

- Status values differ from those listed in the current-state evidence.
- Correct batch handling requires a Supabase schema change.
- Removing the delay causes an existing test to reveal a documented Groq rate-limit requirement. Report the exact constraint; do not invent another fixed delay.
- A verification command fails twice after a reasonable correction.

## Maintenance notes

When adding a future queue status, classify it explicitly as active, success, or failure and add a batch-status test. Rate limiting should be attached to the specific Groq operation that needs it, preferably using upstream retry metadata, not to the entire worker loop.
