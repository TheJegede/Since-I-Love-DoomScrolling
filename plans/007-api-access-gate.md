# Plan 007: Implement API Access Gate (Authentication Key)

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
- **Category**: security
- **Planned at**: commit `9537dd6`, 2026-06-12

## Why this matters

The FastAPI backend is hosted publicly (e.g. on Hugging Face Spaces) to serve frontend write requests. Currently, there is no access control or token check. Anyone who discovers the backend endpoint URL can delete reels, trigger expensive cluster recomputations, or run arbitrary URLs through the GPU Whisper/Llama pipelines, exhausting free-tier usage limits.

Implementing an opt-in authentication token gate secures public backend deployments from unauthorized API consumption without breaking the zero-config local run defaults.

## Current state

- Relevant files:
  - `backend/main.py` — contains server API routes.
  - `frontend/src/App.jsx` — contains client network requests.
- No headers or authorization checks exist on any backend route today.

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
- Direct anonymous read select queries fetching from Supabase (`supabaseClient.js`).

## Steps

### Step 1: Implement authentication check in backend/main.py

Open `backend/main.py` and read the `API_AUTH_TOKEN` environment variable:
`API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN")`

Implement a helper dependency function `verify_api_key(x_api_key: Optional[str] = Header(None))` (using FastAPI `Header` validation). If `API_AUTH_TOKEN` is defined in the environment, assert that the incoming `X-API-Key` header matches it. If it is missing or mismatched, raise `HTTPException(status_code=401, detail="Unauthorized access. Invalid X-API-Key.")`. If `API_AUTH_TOKEN` is not defined in the environment, bypass the check entirely.

Target shape:
```python
from fastapi import Header

API_AUTH_TOKEN = os.getenv("API_AUTH_TOKEN")

def verify_api_key(x_api_key: Optional[str] = Header(None)):
    """Access gate: enforce token check if API_AUTH_TOKEN environment variable is set."""
    if API_AUTH_TOKEN:
        if not x_api_key or x_api_key.strip() != API_AUTH_TOKEN.strip():
            raise HTTPException(status_code=401, detail="Unauthorized API access. Valid X-API-Key header required.")
```

### Step 2: Apply authentication check to state-changing endpoints

Apply the `verify_api_key` check to all POST and DELETE API routes using FastAPI's dependency injection system: `dependencies=[Depends(verify_api_key)]`.

Endpoints to protect:
* `POST /clusters/recompute`
* `POST /extract/url`
* `POST /extract/file`
* `POST /extract/text`
* `POST /extract/batch`
* `DELETE /reels/{reel_id}`

Target shape:
```python
from fastapi import Depends

@app.post("/extract/url", response_model=ExtractionResponse, dependencies=[Depends(verify_api_key)])
async def extract_url(payload: dict):
    ...
```

**Verify**: Run `backend/.venv/Scripts/python backend/verify_pipeline.py`. (Ensure mock tests mock the token if needed, or that they pass since `API_AUTH_TOKEN` is unset in the test environment).

### Step 3: Implement fetch helper in frontend/src/App.jsx

Open `frontend/src/App.jsx` and add a new helper function `fetchWithAuth(url, options)` to manage sending the header and prompting the user if a `401 Unauthorized` occurs.

Target shape:
```javascript
  const fetchWithAuth = async (url, options = {}) => {
    let key = import.meta.env.VITE_API_KEY || localStorage.getItem('transcriber_api_key') || '';
    
    // Inject auth header if key is found
    if (key) {
      options.headers = {
        ...options.headers,
        'X-API-Key': key
      };
    }
    
    let res = await fetch(url, options);
    
    // If backend rejects key with 401, prompt the user for password
    if (res.status === 401) {
      const promptKey = prompt("This action requires a valid API Authentication Key. Please enter it:");
      if (promptKey) {
        localStorage.setItem('transcriber_api_key', promptKey);
        options.headers = {
          ...options.headers,
          'X-API-Key': promptKey
        };
        // Retry request
        res = await fetch(url, options);
      }
    }
    return res;
  };
```

### Step 4: Refactor client write calls in App.jsx to use fetchWithAuth

Search `frontend/src/App.jsx` and replace all write/delete `fetch` routes targeting `API_BASE_URL` with `fetchWithAuth`.

Lines to change:
* `handleRecompute` (calls POST `/clusters/recompute`)
* `handleDelete` (calls DELETE `/reels/...`)
* `handleUrlSubmit` (calls POST `/extract/url`)
* `handleFileSubmit` (calls POST `/extract/file`)
* `handleTextSubmit` (calls POST `/extract/text`)
* `handleBatchSubmit` (calls POST `/extract/batch`)
* `pollBatchStatus` (calls GET `/extract/batch/status` — optional, but recommended to secure reads here too)

**Verify**: Run `cd frontend && npm run test` and check that compilation is clean via `npm run build`.

## Test plan

- In `backend/verify_pipeline.py`, add a test case where `API_AUTH_TOKEN` is mocked in env, and confirm requesting protected endpoints without header returns `401`.
- Run: `backend/.venv/Scripts/python backend/verify_pipeline.py` -> all tests pass.
- In `frontend/src/test/App.test.jsx`, verify that `fetchWithAuth` prompts and retries when mocking a `401` response.

## Done criteria

- [ ] Backend protects write routes with `verify_api_key` Depends checks.
- [ ] Client component uses `fetchWithAuth` to inject headers.
- [ ] Frontend triggers prompt box and saves authentication key on `401`.
- [ ] All tests pass.
- [ ] `plans/README.md` status row updated.

## STOP conditions

- If the prompt box interferes with automated E2E tests (resolved by supplying `VITE_API_KEY` in Vite env during tests to bypass the prompt entirely).

## Maintenance notes

- Human owners of this repo can configure their client key once via local storage or by building their Vite app with the `VITE_API_KEY` variable pre-defined.
