# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Transcriber" — an Instagram Reels information extractor. Ingests a Reel URL (or uploaded audio, or pasted text), downloads + transcribes the audio, and uses an LLM to extract schema-validated JSON insights (`core_topic`, `key_takeaway`, `action_items`, `tools_or_resources`) into a searchable dashboard. Designed to run at **$0/month** on free tiers.

## Architecture

Two independent apps + a shared Supabase Postgres database. No shared build.

- **`backend/`** — Python FastAPI app. The pipeline lives in `main.py`; all persistence goes through `db.py` (Supabase data layer). `main.py` never touches the DB driver directly.
- **`frontend/`** — React 19 + Vite SPA (`src/App.jsx`, single component). Reads reels/clusters **directly from Supabase** via `supabaseClient.js`; writes (ingestion, recompute, delete) go through the backend HTTP API.
- **Supabase** — single `saved_reels` table, source of truth for both apps. Schema managed in Supabase (SQL Editor), **not** in code. `init_local_db` only verifies env vars are present.

### Two roles, one queue
A `saved_reels` row has a `status`: `pending → processing → done` (or `failed`). This drives a producer/worker split:

- **Producers** insert `pending` rows: the iPhone Shortcut (Supabase REST insert direct), `POST /extract/batch` (bulk import), and the synchronous `POST /extract/url` path.
- **Worker** drains `pending` rows: `claim_next_pending` atomically flips one to `processing` (compare-and-set on status to avoid races), runs the pipeline, then `update_reel_result` (`done`) or `mark_failed`. To retry a failure, reset its status to `pending`.

The worker runs two ways:
- In-process background thread, started on FastAPI startup unless `ENABLE_WORKER=0` (`_start_worker` / `_worker_loop`).
- Standalone `run_worker.py` — no FastAPI server, just loops `worker_tick`. This is the **local worker** that processes shares from the iPhone Shortcut (IG blocks datacenter IPs, so the worker must run on a residential machine, not HF).

### Backend pipeline (`backend/main.py`)
Core flow: `download → transcribe → extract → persist`.

- `POST /extract/url` — full synchronous pipeline (`process_reel_url`): `download_and_extract_audio` (yt-dlp + ffmpeg → MP3) → `transcribe_audio` (Groq Whisper) → `extract_structured_json` (Groq Llama) → `save_to_database`. **Cached:** a repeat URL returns the existing row without re-running inference.
- `POST /extract/file` — skips download; transcribes an uploaded audio file.
- `POST /extract/text` — skips download + transcription; runs LLM extraction on pasted transcript/caption directly.
- `POST /extract/batch` — accepts an uploaded `saved_posts.json`, parses reel URLs (`saved_parser.parse_saved_posts`), inserts them as `pending`, and tracks progress in the in-memory `BATCH_JOB`. The worker drains them.
- `GET /extract/batch/status` — aggregates progress by querying Supabase for the tracked URLs' statuses.
- `POST /reels/status` — returns statuses for a list of reel ids/urls (frontend polls queued placeholders).
- `GET /reels` — lists saved rows (with `cluster`), optional `search` (coarse `ilike` fallback; the UI filters in-memory instead).
- `DELETE /reels/{id}` — removes a row.
- `POST /clusters/recompute` — regroups all reels into emergent topic clusters via Llama, persists `cluster` per row. Chunked: `_cluster_one_chunk` clusters batches against existing cluster names, `_merge_cluster_names` collapses near-duplicate themes. Run manually from the dashboard.
- `GET /clusters` — `[{name, count}]` grouped by cluster (NULL → "Unclustered"). Drives the frontend filter dropdown. New reels get `cluster: null` until the next recompute.
- `GET /health` — frontend polls it to detect a cold/sleeping HF backend.

Key behaviors to preserve when editing:
- **Silent-hook short-circuit:** `guard_silent_hook` — transcripts under 15 words fall back to the caption; if no caption either, raise HTTP 400 ("No spoken content detected") *before* any LLM call. Applied to both url and file paths. Avoids summarizing hallucinated song lyrics.
- **Structured output:** `extract_structured_json` forces `response_format={"type": "json_object"}` and validates with the `ReelExtraction` Pydantic model. The model is the contract — changing fields means updating the system prompt, the Pydantic model, the Supabase column shape, and the frontend rendering together. (`action_items` is `List[str]` — a validator coerces dict-shaped LLM output.)
- **Models:** Whisper `whisper-large-v3-turbo`, LLM `llama-3.1-8b-instant`, both via the Groq client (`GROQ_API_KEY`).
- **Cookies:** Instagram blocks anonymous scraping. `get_cookie_file` searches common paths for `cookies.txt`; mount an exported browser session to bypass 403/rate-limit errors. Cookies expire → re-export when IG 403s. Absence is non-fatal.
- **Temp files** are always cleaned up in a `finally` block.

### Data layer (`backend/db.py`)
Every DB op lives here. Backend authenticates with the Supabase **service role** key (bypasses RLS) — must only run on a trusted machine. `row_to_record` maps raw rows to the API shape the frontend expects. Queue primitives: `claim_next_pending`, `update_reel_result`, `mark_failed`. The legacy `backend/local_storage.db` SQLite file is **unused** (pre-migration artifact); `migrate_sqlite_to_supabase.py` was the one-shot migration.

### Frontend (`frontend/src/App.jsx`)
Single-component SPA. Two data channels:
- **Reads** — if `supabase` client is configured (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`), loads reels directly from Supabase via supabase-js. Falls back to `GET /reels?limit=500` otherwise.
- **Writes** — ingestion (url/file/text/bulk), `/clusters/recompute`, and `DELETE /reels/{id}` go through `API_BASE_URL` (`VITE_API_URL`, else `http://localhost:8000` on localhost, else same-origin) (`App.jsx:26`).

Four ingestion modes: URL / file upload / text paste / **bulk** (`saved_posts.json` upload with status polling + progress bar). Search, cluster, tool, and date filters all run **in-memory** over `filteredReels`. Polls `/health` for backend warm-up. Queued (`pending`/`processing`) reels show as placeholders.

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

# Inspect/clean the Supabase queue (pending/processing/failed rows, delete test inserts)
python backend/check_queue.py
```

ffmpeg must be on PATH for url/file ingestion (winget `Gyan.FFmpeg` is not on PATH by default — prepend it).

### Frontend
```powershell
cd frontend
npm install
npm run dev        # Vite dev server
npm run build      # production build
npm run lint       # ESLint
npm run preview    # serve built output
```

## Config & deployment
Required secrets:
- **Backend:** `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role / `sb_secret_` key). `main.py` loads `.env` from `backend/`, falling back to repo-root `.env`. Boots with warnings if absent; DB/inference calls then fail.
- **Frontend:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (for direct reads), `VITE_API_URL` (to point ingestion at a deployed backend).

Gotchas:
- HF Space cold-starts take 30–60s after idle; first share may time out — retry.
- Supabase rejects the `sb_secret_` service key from PowerShell (detects browser context). Use Python + `db.py` for admin queries.
- New REST-inserted rows (iPhone Shortcut) need the `id` column to default to `gen_random_uuid()` in Supabase (Python inserts always supply a UUID, so the default matters only for REST).

Deploy targets:
- **Backend:** Hugging Face Spaces (free CPU Docker). `backend/Dockerfile` installs ffmpeg, runs as user 1000, exposes port **7860** (HF default — differs from local's 8000). Live: `https://whoisluwah-transcriber.hf.space`. *Note:* IG blocks HF/datacenter IPs, so reel downloads must run on the local worker, not HF.
- **Frontend:** Vercel (free hobby). Live: `https://reels-transcriber.vercel.app`.
- **Git remotes:** `origin` = GitHub, `hf` = HF Spaces (deploy backend via subtree split).

## Reference docs
`prd.md`, `The trascriber implementation plan.md`, and `docs/superpowers/` (specs + plans, e.g. share-to-app hybrid, supabase-migration, bulk-import) describe intent and edge-case test scenarios (Resource Drop / Step-by-Step / Silent Hook). Useful for "why," but where they disagree with the code, **trust the code.**
