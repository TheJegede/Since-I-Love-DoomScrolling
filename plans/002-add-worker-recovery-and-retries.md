# Plan 002: Add lightweight worker recovery and bounded retries

> **Executor instructions**: Follow each step and pause at the manual Supabase checkpoint. Do not invent a migration system; this repository intentionally manages schema in the Supabase SQL Editor. Update `plans/README.md` to `DONE` only after both local verification and the manual schema checkpoint succeed.
>
> **Drift check (run first)**: `git diff --stat 4a5e5e3..HEAD -- backend/db.py backend/main.py backend/run_worker.py backend/verify_pipeline.py backend/check_queue.py AGENTS.md README.md`

## Status

- **Priority**: P1
- **Effort**: M (about one day including manual verification)
- **Risk**: MED
- **Depends on**: `plans/001-fix-worker-throughput-and-statuses.md`
- **Category**: correctness, reliability
- **Planned at**: commit `4a5e5e3`, 2026-07-12

## Why this matters

`claim_next_pending` changes a row to `processing` before the long pipeline runs. If the process exits, the computer sleeps, or the network fails at the wrong time, that row remains stuck forever. For a one-user application, a lightweight claim timestamp, startup recovery, and at most three attempts provide most of the value of a durable queue without adding another service or multi-worker machinery.

## Design constraints

- Supabase remains the only queue and source of truth.
- Only one residential worker is expected to run normally.
- No Redis, Celery, heartbeat service, cron service, or paid dependency.
- Keep statuses from Plan 001. Retry metadata belongs in separate columns.
- Automatic retries apply only to plausibly temporary infrastructure failures. Invalid input, silent content, expired cookies, and unsupported formats remain terminal.

## Required schema checkpoint

In the Supabase SQL Editor, add nullable/defaulted columns to `saved_reels`:

```sql
alter table public.saved_reels
  add column if not exists attempt_count integer not null default 0,
  add column if not exists processing_started_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

create index if not exists saved_reels_queue_ready_idx
  on public.saved_reels (status, next_attempt_at, created_at);
```

Do not store this as an executable repository migration because this project explicitly manages schema in Supabase. Add the SQL to the relevant worker/setup documentation so future setup is reproducible.

## Scope

**In scope:**

- `backend/db.py`
- `backend/main.py`
- `backend/run_worker.py`
- `backend/verify_pipeline.py`
- `backend/check_queue.py`
- `AGENTS.md` and/or `README.md` for schema and recovery documentation
- `plans/README.md`

**Out of scope:**

- Transactional RPC or `SKIP LOCKED`
- Multiple simultaneous workers
- Heartbeats or lease renewal
- Retrying cookie/format/silent-content failures
- Frontend controls for retry
- Persisting batch jobs

## Steps

### Step 1: Extend the data-layer queue contract

Modify `claim_next_pending` so eligible rows satisfy:

- `status = pending`, and
- `next_attempt_at` is null or no later than the current UTC time.

When claiming, set `status="processing"`, set `processing_started_at` to current UTC, clear `next_attempt_at`, and increment `attempt_count`. Continue using the current compare-and-set on `status` because only one worker is expected.

Update both success and terminal-failure writes to clear `processing_started_at` and `next_attempt_at`.

Add data-layer functions with narrow responsibilities:

```python
recover_stale_processing(stale_before: datetime) -> int
schedule_retry(reel_id: str, error: str, next_attempt_at: datetime) -> None
```

`recover_stale_processing` resets stale `processing` rows to `pending`, records a short recovery message, and clears `processing_started_at`. It must not touch recently claimed rows.

**Verify**: mocked tests assert every update payload and filter condition, including the null/due retry cases.

### Step 2: Classify retryable failures

Introduce a small explicit classifier in the worker code. Retry only:

- Groq/API HTTP 429 responses.
- Upstream HTTP 5xx failures.
- Network timeout/connection exceptions from known HTTP client types already used by dependencies.
- Temporary Supabase failures that occur before results are durably saved, if they can be identified without broad string matching.

Do not retry:

- HTTP 400 silent-hook/input failures.
- HTTP 403 cookie failures.
- HTTP 415 unsupported media.
- Invalid URLs.
- Pydantic/structured-output validation failures unless the existing Groq call itself reports a retryable upstream status.

Use at most three total attempts. Compute exponential delays with small jitter, approximately 30 seconds then 2 minutes. Inject or isolate the delay calculator so tests can assert ranges without sleeping.

When retryable and attempts remain, call `schedule_retry` and leave the row `pending`. Otherwise use the terminal failure path.

**Verify**: tests cover each classification, attempt 1/2 scheduling, attempt 3 exhaustion, and no real waiting.

### Step 3: Recover stale work once at worker startup

At standalone worker startup, call `recover_stale_processing` with a conservative threshold of 30 minutes before entering the loop. Log only the recovered count.

Also call recovery before starting the optional FastAPI in-process worker. Do not run recovery every tick.

The threshold must be configurable through `WORKER_STALE_MINUTES`, defaulting to 30, parsed and validated once. Invalid or non-positive values should warn and use 30.

This recovery strategy assumes ordinary Reels complete within 30 minutes. If actual measured processing regularly exceeds that threshold, increase the setting; do not add heartbeats in this plan.

**Verify**: startup tests/mock calls show recovery runs once and the worker proceeds when recovery itself succeeds.

### Step 4: Improve the queue inspection script

Update `backend/check_queue.py` to show `attempt_count`, `processing_started_at`, and `next_attempt_at`. Include `cookies_expired` and `unsupported_format` in its non-done query. Keep it read-only except for its existing explicitly named diagnostic test-row cleanup.

**Verify**: import/compile it without connecting to Supabase by using the existing test/mocking style, or add a pure row-formatting helper test.

### Step 5: Manual schema and behavior verification

After the operator runs the SQL checkpoint:

1. Insert or reset a harmless test row to `processing` with `processing_started_at` older than 30 minutes.
2. Start the worker in `--drain` mode.
3. Confirm the startup log reports one recovery and the row is claimed again.
4. Confirm a recent `processing` test row is not reset.
5. Delete the test rows using the existing queue-inspection workflow.

Never use a real valuable row for this verification.

### Step 6: Run the baseline

```powershell
.\backend\.venv\Scripts\python.exe backend\verify_pipeline.py
cd frontend
npm test
npm run lint
npm run build
```

Expected: all exit 0.

## Done criteria

- [ ] A worker restart recovers processing rows older than the configured threshold.
- [ ] Recent processing rows are untouched.
- [ ] Retryable temporary failures are scheduled with bounded backoff.
- [ ] Permanent failures are immediately terminal.
- [ ] No job exceeds three total attempts.
- [ ] Success and terminal failure clear claim/retry timestamps.
- [ ] Queue inspection shows recovery metadata.
- [ ] Schema SQL is documented and applied manually.
- [ ] Full verification baseline passes.

## STOP conditions

- The Supabase table already contains columns with the same names but incompatible types or meanings.
- PostgREST cannot express the null-or-due eligibility filter reliably. Report this; the fallback is a small Supabase RPC, not client-side filtering.
- Existing real jobs commonly take 30 minutes or more.
- Retryable exceptions cannot be classified without matching human-readable error strings.
- Implementing this requires running multiple workers or introducing a paid service.

## Maintenance notes

If multiple workers are ever introduced, replace the two-request compare-and-set claim with a Supabase Postgres RPC using a transaction and `FOR UPDATE SKIP LOCKED`. Until then, the simpler claim is a reasonable tradeoff. Keep retry counts low because Instagram and Groq free tiers reward restraint.
