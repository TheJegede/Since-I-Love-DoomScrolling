# Plan 002: Add URL Validation to Ingestion and Worker (SSRF Guard)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9537dd6..HEAD -- backend/main.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The API route `/extract/url` and the background queue worker process any URL passed to them by downloading it using `yt-dlp`. Because `yt-dlp` supports downloading from arbitrary websites, a malicious user could submit an internal HTTP endpoint (e.g. `http://169.254.169.254` or internal services in the residential network) or a massive file link. This exposes the host machine to Server-Side Request Forgery (SSRF) and storage exhaustion attacks.

Adding strict validation ensures the pipeline only processes legitimate Instagram Reel URLs.

## Current state

- Relevant files:
  - `backend/main.py` — API route endpoints and pipeline functions.
- In `backend/main.py`:
  - `extract_url` route (lines 585–592) processes incoming payloads without validating the url pattern.
  - `process_pending_reel` (lines 594–618) triggers the download pipeline `_run_pipeline` on any URL claimed from the database queue.

## Commands you will need

| Purpose   | Command                                               | Expected on success |
|-----------|-------------------------------------------------------|---------------------|
| Tests     | `backend/.venv/Scripts/python backend/verify_pipeline.py` | all 20+ tests pass  |

## Scope

**In scope** (the only files you should modify):
- `backend/main.py`

**Out of scope**:
- Database functions in `backend/db.py`

## Steps

### Step 1: Add re module import and URL validation function

Open `backend/main.py` and ensure `re` is imported at the top of the file. Implement a helper function `is_valid_instagram_reel(url: str) -> bool` that verifies the URL matches a standard Instagram Reel link format:
`https?://(www\.)?instagram\.com/reel/[A-Za-z0-9_-]+/?.*`

Target shape:
```python
import re

def is_valid_instagram_reel(url: str) -> bool:
    if not url:
        return False
    # Strict regex pattern matching Instagram Reel paths
    pattern = r"^https?://(www\.)?instagram\.com/reel/[A-Za-z0-9_\-]+/?.*$"
    return bool(re.match(pattern, url.strip()))
```

**Verify**: Test the helper using python CLI or simple validation asserts.

### Step 2: Integrate validation into extract_url endpoint

Modify `extract_url` (lines 585–592) in `backend/main.py` to check the URL using `is_valid_instagram_reel` and raise an `HTTPException(status_code=400, detail="Invalid Instagram Reel URL format.")` if validation fails.

Target shape:
```python
@app.post("/extract/url", response_model=ExtractionResponse)
async def extract_url(payload: dict):
    """Accepts an Instagram Reel URL and runs the full extraction pipeline."""
    url = payload.get("url")
    if not url:
        raise HTTPException(status_code=400, detail="Missing required 'url' parameter.")
    
    if not is_valid_instagram_reel(url):
        raise HTTPException(status_code=400, detail="Invalid Instagram Reel URL format.")
        
    return process_reel_url(url)
```

**Verify**: Run `backend/.venv/Scripts/python backend/verify_pipeline.py` to confirm mock pipeline tests still pass.

### Step 3: Integrate validation into the queue worker process_pending_reel

Modify `process_pending_reel` (lines 594–618) in `backend/main.py` to validate the URL before invoking the pipeline. If invalid, mark the reel as failed with a descriptive error message.

Target shape:
```python
def process_pending_reel(row: dict) -> None:
    reel_id = row["id"]
    url = row["url"]
    
    if not is_valid_instagram_reel(url):
        logger.warning(f"Worker rejected reel {reel_id}: Invalid URL format ({url})")
        db.mark_failed(reel_id, f"Invalid Instagram Reel URL format: {url}")
        return

    try:
        title, raw_transcript, post_caption, extracted = _run_pipeline(url)
        ...
```

**Verify**: Run the full test suite `backend/.venv/Scripts/python backend/verify_pipeline.py`.

## Test plan

- Create a new unit test in `backend/verify_pipeline.py` that mocks `extract_url` with a malicious URL (e.g. `http://169.254.169.254` or `https://google.com`) and asserts it returns `400 Bad Request`.
- Run: `backend/.venv/Scripts/python backend/verify_pipeline.py` -> all tests pass.

## Done criteria

- [ ] `is_valid_instagram_reel` is defined and used in `extract_url` and `process_pending_reel`.
- [ ] Arbitrary URL submissions to `/extract/url` fail with HTTP 400.
- [ ] No files outside `backend/main.py` and `backend/verify_pipeline.py` are modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If yt-dlp is expected to download non-Reel URLs (not the case based on PRD).

## Maintenance notes

- If Instagram changes their Reel URL structure (e.g. introduces subdomains other than `www`), the regex pattern must be updated.
