# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Transcriber" — an Instagram Reels information extractor. Ingests a Reel URL (or uploaded audio, or pasted text), downloads + transcribes the audio, and uses an LLM to extract schema-validated JSON insights (`core_topic`, `key_takeaway`, `action_items`, `tools_or_resources`) into a searchable dashboard. Designed to run at **$0/month** on free tiers.

## Architecture

Two independent apps, no shared build:

- **`backend/`** — Python FastAPI single-file app (`main.py`). The entire pipeline lives here.
- **`frontend/`** — React 19 + Vite SPA (`src/App.jsx`, single component). Talks to the backend over HTTP.

### Backend pipeline (`backend/main.py`)
The core flow is `download → transcribe → extract → persist`, exposed via three ingestion endpoints that all converge on `save_to_database`:

- `POST /extract/url` — full pipeline. `download_and_extract_audio` (yt-dlp + ffmpeg → MP3 in tmp) → `transcribe_audio` (Groq Whisper) → `extract_structured_json` (Groq Llama) → save. URL results are **cached**: a repeat URL returns the existing DB row without re-running inference.
- `POST /extract/file` — skips download; transcribes an uploaded audio file.
- `POST /extract/text` — skips download + transcription; runs LLM extraction on pasted transcript/caption directly.
- `GET /reels` — lists saved rows, with optional `search` (SQL `LIKE` across title/transcript/caption/JSON).
- `GET /health` — used by the frontend to detect a cold/sleeping backend.

Key behaviors to preserve when editing:
- **Silent-hook short-circuit:** transcripts under 15 words fall back to the caption; if no caption either, return HTTP 400 ("No spoken content detected") *before* any LLM call. This avoids summarizing hallucinated song lyrics.
- **Structured output:** `extract_structured_json` forces `response_format={"type": "json_object"}` and validates with the `ReelExtraction` Pydantic model. The model is the contract — changing fields means updating the system prompt, the Pydantic model, the DB JSON, and the frontend rendering together.
- **Models:** Whisper `whisper-large-v3-turbo`, LLM `llama-3.1-8b-instant`, both via the Groq client (`GROQ_API_KEY`).
- **Cookies:** Instagram blocks anonymous scraping. `get_cookie_file` searches common paths for `cookies.txt`; mount one (exported browser session) to bypass 403/rate-limit errors. Absence is non-fatal.
- **Temp files** are always cleaned up in a `finally` block.

### Storage
Embedded **SQLite** at `backend/local_storage.db` (`saved_reels` table), created on startup by `init_local_db`. No external DB, despite the implementation-plan doc mentioning Supabase/Postgres — the actual code uses SQLite. The doc is aspirational; the code is the source of truth.

### Frontend (`frontend/src/App.jsx`)
Single-component SPA. API base resolves via `import.meta.env.VITE_API_URL`, falling back to `http://localhost:8000` on localhost or same-origin in production (`App.jsx:25`). Polls `/health` to show a backend warm-up state. Mirrors the three backend ingestion modes (URL / file upload / text paste) plus a searchable card grid.

## Commands

### Backend
```powershell
# From repo root or backend/ — sets up .venv, installs deps, starts uvicorn on :8000 with reload
backend/run_local.ps1

# Manual run (venv already active)
uvicorn main:app --host 0.0.0.0 --port 8000 --reload   # run from backend/

# Pipeline tests (mocks Groq, uses FastAPI TestClient — no API key needed)
python backend/verify_pipeline.py
```

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
- **`GROQ_API_KEY`** is the only required secret. `main.py` loads `.env` from `backend/` and falls back to the repo-root `.env`. Backend warns but still boots without it; inference endpoints then 500.
- Frontend optional: **`VITE_API_URL`** to point at a deployed backend.
- **Backend deploy target:** Hugging Face Spaces (free CPU). `backend/Dockerfile` installs ffmpeg, runs as user 1000, exposes port **7860** (HF default) — note the port differs from local's 8000.
- **Frontend deploy target:** Vercel (free hobby).

## Reference docs
`prd.md` and `The trascriber implementation plan.md` describe intent and edge-case test scenarios (Resource Drop / Step-by-Step / Silent Hook). Useful for "why," but where they disagree with the code (e.g. Supabase vs SQLite), trust the code.
