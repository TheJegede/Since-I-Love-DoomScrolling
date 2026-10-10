# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Transcriber" — an Instagram Reels information extractor. Ingests a Reel URL (or uploaded audio, or pasted text), downloads + transcribes the audio, and uses an LLM to extract schema-validated JSON insights (`core_topic`, `key_takeaway`, `action_items`, `tools_or_resources`) into a searchable dashboard. Designed to run at **$0/month** on free tiers.

## Architecture

Two independent apps + a shared Supabase Postgres database. No shared build.

- **`backend/`** — Python FastAPI app. The pipeline lives in `main.py`; all persistence goes through `db.py` (Supabase data layer). `main.py` never touches the DB driver directly.
- **`frontend/`** — React 19 + Vite SPA (`src/App.jsx` shell + `src/components/`). Reads reels **directly from Supabase** via `supabaseClient.js`; writes (ingestion, recompute, retry, delete) go through the backend HTTP API.
- **Supabase** — single `saved_reels` table, source of truth for both apps. Schema managed in Supabase (SQL Editor), **not** in code. `init_local_db` only verifies env vars are present.

### Two roles, one queue
A `saved_reels` row has a `status`: `pending → processing → done`, or a failure status (`failed`, `cookies_expired`, `unsupported_format` — `db.FAILURE_STATUSES`). This drives a producer/worker split:

- **Producers** insert `pending` rows: the iPhone Shortcut (Supabase REST insert direct, so `title` is NULL until processed) and `POST /extract/batch` (bulk import). `POST /extract/url` runs the pipeline synchronously and inserts a `done` row.
- **Worker** drains `pending` rows: `claim_next_pending` atomically flips one to `processing` (compare-and-set on status to avoid races), runs the pipeline, then `update_reel_result` (`done`) or `mark_failed`. Transient errors (429/5xx/network) are rescheduled with backoff up to `MAX_WORKER_ATTEMPTS` (`schedule_retry`); claims abandoned for `WORKER_STALE_MINUTES` are recovered on worker start. The dashboard Retry button calls `POST /reels/{id}/retry`.

One loop, `run_worker()` in `main.py`, runs two ways:
- In-process background thread, started on FastAPI startup unless `ENABLE_WORKER=0` or running on an HF Space.
- Standalone `run_worker.py` — no FastAPI server. This is the **local worker** that processes shares from the iPhone Shortcut (IG blocks datacenter IPs, so the worker must run on a residential machine, not HF). `--drain` exits once the queue is empty; `schedule_worker.ps1` registers that as a 5-minute scheduled task.

### Backend pipeline (`backend/main.py`)
Core flow: `download → transcribe → extract → persist` (`_run_pipeline`).

- `POST /extract/url` — full synchronous pipeline (`process_reel_url`): `download_and_extract_audio` (yt-dlp + ffmpeg → MP3) → `transcribe_audio` (Groq Whisper) → `extract_structured_json` (Groq LLM) → `db.insert_reel`. **Cached:** a repeat URL returns the existing row without re-running inference — including rows that are still queued or failed, which is why `ExtractionResponse` carries `status`/`error` and allows an empty `extracted_json`.
- `POST /extract/file` — skips download; transcribes an uploaded audio file.
- `POST /extract/text` — skips download + transcription; runs LLM extraction on pasted transcript/caption directly.
- `POST /extract/batch` — accepts an uploaded `saved_posts.json`, parses reel URLs (`saved_parser.parse_saved_posts`), inserts new ones as `pending`, and tracks progress in the in-memory `BATCH_JOB`. The worker drains them.
- `GET /extract/batch/status` — aggregates progress by querying Supabase for the tracked URLs' statuses.
- `GET /reels` — lists saved rows (fallback for a frontend without Supabase config).
- `GET /reels/{id}/details` — transcript + caption for one reel. `POST /reels/{id}/retry` — requeue a failed reel. `DELETE /reels/{id}` — removes a row.
- `POST /clusters/recompute` — regroups all extracted reels into 8–12 topic clusters in a background task (`cluster_topics_semantically`): local embeddings (fastembed) → agglomerative clustering (scikit-learn) → one LLM call to name the clusters. Queued/failed reels are reset to Unclustered. Poll `GET /clusters/recompute/status`. Run manually from the dashboard; new reels have `cluster: null` until then.
- `GET /health` — frontend polls it to detect a cold/sleeping HF backend.

Endpoints are plain `def` on purpose: the pipeline and Supabase calls block, so FastAPI must run them in its threadpool. Write endpoints require an `X-API-Key` header when `API_AUTH_TOKEN` is set.

Key behaviors to preserve when editing:
- **Silent-hook short-circuit:** `guard_silent_hook` — transcripts under 15 words fall back to the caption; if no caption either, raise HTTP 400 ("No spoken content detected") *before* any LLM call. Applied to both url and file paths. Avoids summarizing hallucinated song lyrics.
- **Structured output:** `extract_structured_json` forces `response_format={"type": "json_object"}` and validates with the `ReelExtraction` Pydantic model. The model is the contract — changing fields means updating the system prompt, the Pydantic model, the Supabase column shape, and the frontend rendering together. (`action_items` is `List[str]` — a validator coerces dict-shaped LLM output.)
- **Models:** Whisper `whisper-large-v3-turbo`; LLM `GROQ_LLM_MODEL` (default `openai/gpt-oss-120b`) with `GROQ_LLM_FALLBACK_MODELS` tried in order. `_chat_json` owns that failover loop for both extraction and cluster naming. See `ERRORS.md` for why the models changed.
- **Cookies:** Instagram blocks anonymous scraping. `get_cookie_file` searches common paths for `cookies.txt`; mount an exported browser session to bypass 403/rate-limit errors. Cookies expire → re-export when IG 403s. Absence is non-fatal.
- **Temp files** are always cleaned up in a `finally` block.

### Data layer (`backend/db.py`)
Every DB op lives here. Backend authenticates with the Supabase **service role** key (bypasses RLS) — must only run on a trusted machine. `row_to_record` maps raw rows to the API shape the frontend expects. Queue primitives: `claim_next_pending`, `update_reel_result`, `mark_failed`, `schedule_retry`, `recover_stale_processing`, `retry_reel`. Supabase returns at most 1000 rows per request, so full-table reads page (`_select_newest_first`) and `in` filters are chunked. The legacy `backend/local_storage.db` SQLite file is **unused** (pre-migration artifact).

### Frontend (`frontend/src/`)
- `App.jsx` — shell: loads reels, owns search/cluster/tool/date filters, pagination, the selected reel, and cluster recompute. The cluster list is derived from the loaded reels.
- `components/IngestionPanel.jsx` — owns the four ingestion modes (URL / file upload / text paste / **bulk** `saved_posts.json` with status polling + progress bar) and reports results up through `onIngested` / `onError` / `onBatchFinished`.
- `components/ReelModal.jsx`, `ReelCard.jsx`, `InsightsTable.jsx`, `Skeletons.jsx` — presentation. Queued (`pending`/`processing`) and failed reels render as placeholders/banners.
- `api.js` — `API_BASE_URL` (`VITE_API_URL`, else `http://localhost:8000` on localhost, else same-origin) and `fetchWithAuth` (adds `X-API-Key`, prompts for it on a 401).

Two data channels:
- **Reads** — if the `supabase` client is configured (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`), `fetchAllReelRows` pages through the whole table via supabase-js. Falls back to `GET /reels` otherwise.
- **Writes** — ingestion, `/clusters/recompute`, retry and delete go through `API_BASE_URL`.

All filters run **in-memory** over `filteredReels`. Checks `/health` on load for backend warm-up and re-fetches every 5s while any reel is queued. Styles live in `index.css` (tokens + base) and `App.css` (layout + components); avoid inline `style` except for values computed at runtime.

## Commands

### Backend
```powershell
# From repo root or backend/ — sets up .venv, installs deps, starts uvicorn on :8000 with reload
backend/run_local.ps1

# Manual run (venv already active, from backend/)
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Standalone local worker (drains the Supabase queue; no FastAPI server needed)
python backend/run_worker.py

# Pipeline tests (mocks Groq + DB, FastAPI TestClient, ENABLE_WORKER=0 — no real keys/server)
python backend/verify_pipeline.py

# Bulk-import a saved_posts.json via the running backend (resumable, see file docstring)
python backend/batch_import.py path/to/saved_posts.json

# Inspect the Supabase queue (pending/processing/failed rows)
python backend/check_queue.py
```

ffmpeg must be on PATH for url/file ingestion (winget `Gyan.FFmpeg` is not on PATH by default — `main.py` prepends it when found). Cluster recompute needs `fastembed` and `scikit-learn` from `requirements.txt`; an older venv may be missing them.

### Frontend
```powershell
cd frontend
npm install
npm run dev        # Vite dev server
npm run build      # production build
npm run lint       # ESLint
npm test           # Vitest (jsdom)
npm run preview    # serve built output
```

## Config & deployment
Required secrets:
- **Backend:** `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role / `sb_secret_` key). `main.py` loads `.env` from `backend/`, falling back to repo-root `.env`. Boots with warnings if absent; DB/inference calls then fail.
- **Backend, optional:** `API_AUTH_TOKEN` (protects write endpoints), `GROQ_LLM_MODEL`, `GROQ_LLM_FALLBACK_MODELS`, `EMBEDDING_MODEL_NAME`, `WORKER_STALE_MINUTES`, `ENABLE_WORKER`.
- **Frontend:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (for direct reads), `VITE_API_URL` (to point ingestion at a deployed backend), optional `VITE_API_KEY`.

Gotchas:
- HF Space cold-starts take 30–60s after idle; first share may time out — retry.
- Supabase rejects the `sb_secret_` service key from PowerShell (detects browser context). Use Python + `db.py` for admin queries.
- New REST-inserted rows (iPhone Shortcut) need the `id` column to default to `gen_random_uuid()` in Supabase (Python inserts always supply a UUID, so the default matters only for REST).

Deploy targets:
- **Backend:** Hugging Face Spaces (free CPU Docker). `backend/Dockerfile` installs ffmpeg, runs as user 1000, exposes port **7860** (HF default — differs from local's 8000). Live: `https://whoisluwah-transcriber.hf.space`. *Note:* IG blocks HF/datacenter IPs, so reel downloads must run on the local worker, not HF.
- **Frontend:** Vercel (free hobby). Live: `https://reels-transcriber.vercel.app`. Pushing `main` to `origin` auto-deploys it.
- **Git remotes:** `origin` = GitHub, `hf` = HF Spaces (deploy backend via `git subtree push --prefix=backend hf main`).

## Reference docs
`prd.md` describes intent and edge-case test scenarios (Resource Drop / Step-by-Step / Silent Hook); `ERRORS.md` logs past failures and their fixes. Useful for "why," but where they disagree with the code, **trust the code.**
